/**
 * lib/signature.js — one sign-off, shared by all three campaigns.
 *
 * WHY THIS FILE EXISTS. On 2026-08-18 the HTML build was removed because it was the confirmed
 * cause of Gmail spam-foldering and Microsoft Defender quarantining the mail as PHISHING. The
 * signature was the reason: anchor text "aevon.ca" pointing at aevon.ca/<vertical>.html?ref=uuid,
 * anchor text "Book a call" hiding calendar.app.google, and a remote-loaded logo. Display text
 * that disagrees with its destination is the strongest phishing signal a filter has.
 *
 * That fix was right and moved Gmail from Spam to Inbox. What nobody noticed is that it left the
 * signature behind entirely: it lived only in sender.js toHtml(), which is now dead code, while
 * the personalizer prompt still instructs the model to write "No sign-off (the signature handles
 * that)". So every Aevon email since 18 August went out with no name on it at all. Robert at
 * Lindquist & Kornfeld received an unsigned note from a stranger and replied "NO" on 25 August.
 *
 * WHOSE SIGNATURE THIS IS. The content comes from Aidan's real Gmail signature, read from the
 * account on 2026-08-25 (gmail.users.settings.sendAs). In Gmail it is an HTML table, and it is
 * precisely the thing the deliverability note blames:
 *
 *     <img src="https://aevon.ca/logo.svg">                     a remote image
 *     <a href="mailto:aidan@aevon.ca">aevon.ca</a>              text says a site, link is an email
 *     <a href="https://calendar.app.google/...">Book a call</a> masked external domain
 *
 * Three deception heuristics stacked in four lines. So the CONTENT is kept and the FORM is not.
 * In plain text every URL is its own display text, there is nothing for a filter to catch lying,
 * and the booking link he actually wants people to use survives as a visible address.
 *
 * The rules it has to keep:
 *   - the sender's name, because an unsigned cold email is a stranger with no face
 *   - the company and the bare domain, written out, so the text IS the destination
 *   - the booking link as a naked URL, never as anchor text over a different address
 *   - a working opt-out, honoured by the reply scanners
 *   - nothing else. A signature is identification, not a second pitch.
 */

/** From Aidan's Gmail signature. Naked URL, never hidden behind words. */
const BOOKING_URL = 'https://calendar.app.google/7R7srDKzWrvmLQg37';

/**
 * @param {object} opts
 * @param {string} opts.optOut       the opt-out sentence for this campaign
 * @param {string} [opts.address]    physical mailing address, if one is configured
 * @param {boolean} [opts.booking]   include the booking link. ON by default because it is in
 *                                   Aidan's real signature. Aevon's own copy rule says no link
 *                                   in email 1, so that campaign passes false for the first
 *                                   touch: a signature link still reads as a call to action when
 *                                   the body deliberately made no ask.
 */
function signature({ optOut, address = '', booking = true } = {}) {
  // Matches the signature Aidan's Gmail already uses, in plain text: a sign-off, the name, the
  // site, the booking link. No tagline and no demo link; the ask is the call to action and a
  // second one competes with it. The mailing address line is dropped entirely when unset.
  const block = ['Best,', 'Aidan Cox', 'aevon.ca', address, booking ? `Book a call: ${BOOKING_URL}` : ''].filter(Boolean).join('\n');
  return `\n\n${block}\n\n${optOut}`;
}

module.exports = { signature };
