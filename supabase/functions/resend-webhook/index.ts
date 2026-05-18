import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

async function verifySignature(req: Request, body: string): Promise<boolean> {
  const secret = Deno.env.get('RESEND_WEBHOOK_SECRET');
  if (!secret) return true;

  const svixId        = req.headers.get('svix-id');
  const svixTimestamp = req.headers.get('svix-timestamp');
  const svixSignature = req.headers.get('svix-signature');
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${svixId}.${svixTimestamp}.${body}`));
  const computed = 'v1,' + btoa(String.fromCharCode(...new Uint8Array(sig)));

  return svixSignature.split(' ').some(s => s === computed);
}

const EVENT_MAP: Record<string, string> = {
  'email.delivered':  'delivered',
  'email.opened':     'opened',
  'email.clicked':    'clicked',
  'email.bounced':    'bounced',
  'email.complained': 'complained',
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body = await req.text();

  if (!(await verifySignature(req, body))) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: { type: string; data: Record<string, unknown> };
  try { payload = JSON.parse(body); } catch { return new Response('Invalid JSON', { status: 400 }); }

  const eventType = EVENT_MAP[payload.type];
  if (!eventType) return new Response('Ignored', { status: 200 });

  const emailId = payload.data?.email_id as string;
  if (!emailId) return new Response('Missing email_id', { status: 400 });

  // Find lead by either email ID column
  const { data: leads } = await sb
    .from('leads')
    .select('id, opened_at, clicked_at, status')
    .or(`resend_email_id.eq.${emailId},resend_followup_id.eq.${emailId}`)
    .limit(1);

  const lead = leads?.[0];

  // Always log the event
  await sb.from('email_events').insert({
    lead_id: lead?.id ?? null,
    resend_email_id: emailId,
    event_type: eventType,
    metadata: payload.data,
  });

  if (lead) {
    const updates: Record<string, unknown> = {};
    if (eventType === 'opened'    && !lead.opened_at)  updates.opened_at  = new Date().toISOString();
    if (eventType === 'clicked'   && !lead.clicked_at) updates.clicked_at = new Date().toISOString();
    if (eventType === 'bounced')    updates.status = 'bounced';
    if (eventType === 'complained') updates.status = 'complained';
    if (Object.keys(updates).length) await sb.from('leads').update(updates).eq('id', lead.id);
  }

  return new Response('OK', { status: 200 });
});
