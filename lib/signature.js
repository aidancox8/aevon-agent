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
 * @param {string} [opts.firstName]  the informal sign-off above the block
 * @param {string} [opts.tagline]    one line on what the product is. Off by default and used
 *                                   only by Cadre, where the product needs naming somewhere and
 *                                   the email body deliberately does not name it. Anything
 *                                   longer than a line is a second pitch, not a signature.
 * @param {boolean} [opts.booking]   include the booking link. ON by default because it is in
 *                                   Aidan's real signature. Aevon's own copy rule says no link
 *                                   in email 1, so that campaign passes false for the first
 *                                   touch: a signature link still reads as a call to action when
 *                                   the body deliberately made no ask.
 * @param {string} [opts.demo]       a naked demo URL, shown as its own line in place of the bare
 *                                   domain. Cadre passes its clickable sandbox: a demo link
 *                                   turns "worth ten minutes?" into something answerable at
 *                                   midnight without a reply. Text equals destination, the one
 *                                   link shape the deliverability incidents allow.
 */
function signature({ optOut, address = '', firstName = 'Aidan', tagline = '', booking = true, demo = '' } = {}) {
  const block = [
    'Aidan Cox',
    'Aevon',
    address,                       // dropped entirely when unset, never left as a blank line
    tagline,
    demo ? `See it working: ${demo}` : 'aevon.ca',
    booking ? `Book a call: ${BOOKING_URL}` : '',
  ].filter(Boolean).join('\n');

  // The informal first name sits above the block the way a person actually types it, then the
  // block identifies who that is. Two newlines before the '--' so mail clients that fold
  // signatures fold this and nothing else.
  return `\n\n${firstName}\n\n--\n${block}\n\n${optOut}`;
}

module.exports = { signature };
