/**
 * interest — the "I'm interested" form on aevon.ca.
 *
 * WHY THIS EXISTS RATHER THAN REUSING track-visit. track-visit only records against a known
 * lead: posting to it without a valid ?ref returns 204 and writes NOTHING. That is fine for
 * attributing a tagged outreach click, and useless for a stranger who found the site and filled
 * in the form. Verified before building this: two test posts, both 204, zero rows.
 *
 * So this one stores every submission unconditionally and emails Aidan straight away, because a
 * form that quietly loses a warm lead is worse than no form.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: CORS });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* fall through to validation */ }

  const name = clean(body.name, 120);
  const email = clean(body.email, 200);
  const phone = clean(body.phone, 60);
  const message = clean(body.message, 2000);
  const page = clean(body.page, 200);
  const ref = clean(body.ref, 40);

  // Name and email are required; everything else is optional. Validate here rather than trusting
  // the page, because the page is the one thing an attacker controls.
  if (!name || !email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'name and a valid email are required' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { error } = await supabase.from('inbound_interest').insert({
    name, email,
    phone: phone || null,
    message: message || null,
    page: page || null,
    lead_ref: /^[0-9a-f-]{36}$/i.test(ref) ? ref : null,
    user_agent: (req.headers.get('user-agent') || '').slice(0, 300),
  });
  if (error) {
    console.error('insert failed', error.message);
    return new Response(JSON.stringify({ error: 'could not save' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // Notify immediately. A failure here must not fail the request: the row is already saved, and
  // the visitor should not see an error because our mail provider had a bad minute.
  const key = Deno.env.get('RESEND_API_KEY');
  if (key) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Aevon site <aidan@aevon.ca>',
          to: ['aidan@aevon.ca'],
          reply_to: email,
          subject: `Interested: ${name}${page ? ' (' + page + ')' : ''}`,
          text: [
            `${name} <${email}>`,
            phone ? `Phone: ${phone}` : null,
            page ? `Page: ${page}` : null,
            ref ? `Lead ref: ${ref}` : null,
            '',
            message || '(no message left)',
          ].filter(Boolean).join('\n'),
        }),
      });
    } catch (e) {
      console.error('notify failed', String(e));
    }
  }

  return new Response(JSON.stringify({ ok: true }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } });
});
