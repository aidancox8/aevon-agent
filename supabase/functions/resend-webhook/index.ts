import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const payload = await req.json();
  const eventType: string = payload.type;
  const emailId: string = payload.data?.email_id;

  if (!emailId || !eventType) {
    return new Response('Missing fields', { status: 400 });
  }

  // Map Resend event types to our event types
  const typeMap: Record<string, string> = {
    'email.delivered':    'delivered',
    'email.opened':       'opened',
    'email.clicked':      'clicked',
    'email.bounced':      'bounced',
    'email.complained':   'complained',
  };

  const mappedType = typeMap[eventType];
  if (!mappedType) {
    return new Response('Ignored event type', { status: 200 });
  }

  // Find the lead by resend_email_id or resend_followup_id
  const { data: leads } = await supabase
    .from('leads')
    .select('id, status')
    .or(`resend_email_id.eq.${emailId},resend_followup_id.eq.${emailId}`)
    .limit(1);

  const lead = leads?.[0];

  // Log event
  await supabase.from('email_events').insert({
    lead_id: lead?.id ?? null,
    resend_email_id: emailId,
    event_type: mappedType,
    metadata: payload.data ?? {},
  });

  // Update lead status based on event
  if (lead) {
    const updates: Record<string, unknown> = {};

    if (mappedType === 'opened' && !lead.status.includes('opened')) {
      updates.opened_at = new Date().toISOString();
    }
    if (mappedType === 'clicked') {
      updates.clicked_at = new Date().toISOString();
    }
    if (mappedType === 'bounced' || mappedType === 'complained') {
      updates.status = mappedType;
    }

    if (Object.keys(updates).length > 0) {
      await supabase.from('leads').update(updates).eq('id', lead.id);
    }
  }

  return new Response('OK', { status: 200 });
});
