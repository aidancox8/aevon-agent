/**
 * watch, playback beacons from the demo video pages on aevon.ca.
 *
 * A prospect gets a personal link (?t=<token>). The page beacons play, pause, ended, a heartbeat
 * every ten seconds while playing, and each quarter milestone. Every beacon is stored as a row so
 * "did she watch it, and how far" is answerable from the table. Aidan gets one email on the first
 * play per token and one when the video is watched through, nothing in between.
 *
 * Unlike track-visit this stores every event unconditionally: a beacon that quietly writes nothing
 * would make "no rows" mean "not watched" when it could mean "broken".
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
  try { body = await req.json(); } catch { /* validation below */ }

  const token = clean(body.t, 60);
  const video = clean(body.v, 60) || 'front-desk';
  const event = clean(body.e, 20);
  const session = clean(body.s, 40);
  const position = Math.max(0, Math.round(Number(body.p) || 0));
  const duration = Math.max(0, Math.round(Number(body.d) || 0));
  if (!token || !event) return new Response('bad request', { status: 400, headers: CORS });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Has this token played before? Decides whether to email, and must be read before the insert.
  const { count: priorPlays } = await supabase.from('video_watch')
    .select('id', { count: 'exact', head: true }).eq('token', token).eq('event', 'play');
  const { count: priorEnds } = await supabase.from('video_watch')
    .select('id', { count: 'exact', head: true }).eq('token', token).eq('event', 'ended');

  const { error } = await supabase.from('video_watch').insert({
    token, video, event, session: session || null, position, duration,
    user_agent: (req.headers.get('user-agent') || '').slice(0, 300),
  });
  if (error) {
    console.error('insert failed', error.message);
    return new Response('could not save', { status: 500, headers: CORS });
  }

  const firstPlay = event === 'play' && (priorPlays || 0) === 0;
  const firstEnd = event === 'ended' && (priorEnds || 0) === 0;
  const key = Deno.env.get('RESEND_API_KEY');
  if (key && (firstPlay || firstEnd)) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Aevon site <aidan@aevon.ca>',
          to: ['aidan@aevon.ca'],
          subject: firstPlay ? `${token} started the ${video} video` : `${token} watched the ${video} video to the end`,
          text: [
            `Token: ${token}`, `Video: ${video}`, `Event: ${event} at ${position}s of ${duration}s`,
            `UA: ${req.headers.get('user-agent') || ''}`,
          ].join('\n'),
        }),
      });
    } catch (e) { console.error('notify failed', (e as Error).message); }
  }

  return new Response(null, { status: 204, headers: CORS });
});
