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
 * A plain-text signature carries none of the original risk. There are no anchors to lie, and no
 * images to load. The rules it has to keep are simple:
 *   - the sender's name, because an unsigned cold email is a stranger with no face
 *   - the company and the bare domain, written out, so the text IS the destination
 *   - a working opt-out, honoured by the reply scanners
 *   - nothing else. A signature is identification, not a second pitch.
 */

/**
 * @param {object} opts
 * @param {string} opts.optOut       the opt-out sentence for this campaign
 * @param {string} [opts.address]    physical mailing address, if one is configured
 * @param {string} [opts.firstName]  the informal sign-off above the block
 * @param {string} [opts.tagline]    one line on what the product is. Off by default and used
 *                                   only by Cadre, where the product needs naming somewhere and
 *                                   the email body deliberately does not name it. Anything
 *                                   longer than a line is a second pitch, not a signature.
 */
function signature({ optOut, address = '', firstName = 'Aidan', tagline = '' } = {}) {
  const block = [
    'Aidan Cox',
    'Aevon',
    address,                       // dropped entirely when unset, never left as a blank line
    tagline,
    'aevon.ca',
  ].filter(Boolean).join('\n');

  // The informal first name sits above the block the way a person actually types it, then the
  // block identifies who that is. Two newlines before the '--' so mail clients that fold
  // signatures fold this and nothing else.
  return `\n\n${firstName}\n\n--\n${block}\n\n${optOut}`;
}

module.exports = { signature };
