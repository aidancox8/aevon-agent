#!/usr/bin/env node
/**
 * cadre/contacts-round2.js — second contact pass, and several corrections that matter.
 *
 * Two genuine personal addresses found across sixteen companies. Both came from places a
 * company website never publishes: an industry association directory PDF, and a contact page
 * that happens to expose per-person mailto links. That is now three finds from association
 * directories and one from a parliamentary committee brief, versus zero from About pages.
 *
 * Three findings that would have caused real damage:
 *  - The Ebco draft was addressed to a person who has LEFT the company, at an address they
 *    never published.
 *  - Garibaldi Glass's owner died in January 2026.
 *  - AgWest's contact in the brief is stale; their actual CEO is someone else entirely.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');

const UPDATES = [
  // ---- Real personal addresses ----
  ['AgWest Ltd.', {
    contact_name: 'Laura Kleiner', contact_role: 'Senior Human Resources Manager',
    email: 'laura.kleiner@agwest.com', email_quality: 'personal', qualification_score: 10,
    notes: 'TOP LEAD. Real mailto read from their own contact page, published under her name and title. CORRECTION: Neil Douglas is NOT on the current team; the published CEO is Derrick Webster. Do not open by referencing Neil Douglas. Their whole leadership block publishes firstname.lastname@agwest.com. FETCH NOTE: www.agwest.com/contact 403s, the apex agwest.com/contact/ works. HOOK: advertising a Training and Safety Coordinator with no named contact.' }],

  ['North Mountain Construction', {
    contact_name: 'Gabe Tyler', contact_role: 'Managing Director and Founder',
    email: 'gabe@northmountainconstruction.ca', email_quality: 'personal', qualification_score: 10,
    notes: 'TOP LEAD. Address extracted from the Roofing Contractors Association of BC membership directory PDF, and stable across the Feb 2024, Sept 2024 and Feb 2025 editions. Filed under sister company Heritage Roofing at the Taghum Frontage Road address, which is North Mountain’s own second location. Their site publishes only info@. 17 named leaders and not one is HR or safety, which is itself the pitch.' }],

  // ---- Corrections that prevent damage ----
  ['Ebco Industries Ltd', {
    contact_name: 'Eden Poon', contact_role: 'People and Culture Generalist',
    email: 'info@ebco.com', email_quality: 'generic', qualification_score: 7,
    notes: 'DRAFT ERROR CAUGHT: the earlier draft went to aliiqbal@ebco.com. That address is not published on any Ebco page and ALI IQBAL HAS LEFT the company. Also do not address Vickii Paramanathan, the previous HR Generalist, who has also left. info@ebco.com is the ONLY address Ebco publishes. Eden Poon is LinkedIn/TheOrg only; her profile lists safety committees and staff training, so the fit is good. Site-verified alternate: Ivan Barreras Fernandez, Director of Operations.' }],

  ['Garibaldi Glass Industries Inc.', {
    email: null, email_quality: null, qualification_score: 5,
    notes: 'DO NOT SEND YET. Longtime owner and President Carey Mobius DIED 7 January 2026; do not address anything to him. The Director of People and Culture seat is vacant or only just filled, with the search live via a recruiter at $110-130k as of ~March 2026, and that role explicitly owns HR, safety and training, so it IS the buyer. Phone reception on +1 604 420 4527 to get the incumbent’s name first. resumes@garibaldiglass.com is a resumes inbox and the wrong door.' }],

  ['Phantom Screens', {
    contact_name: 'Philippa (PJ) Johnston', contact_role: 'Vice President, Employee Experience',
    email: 'hr@phantomscreens.com', email_quality: 'role', qualification_score: 9,
    notes: 'STRONG ANGLE: they run DAYFORCE and their own job ad says training documentation lives in it, so the gap can be argued against their vendor’s stated limits rather than as a general claim. Their Employee Experience Coordinator posting confirms that role reports to the VP Employee Experience and owns HRIS, so she is the right target. VERIFY IN A BROWSER: phantomscreens.com 403s site-wide to fetchers, so hr@ came from search-index results attributing it to their careers page. Do NOT construct pjohnston@.' }],

  ['Superior Cabinets', {
    contact_name: 'Yvonne Moasun', contact_role: 'Director of Human Resources',
    email: 'careers@superiorcabinets.ca', email_quality: 'role', qualification_score: 9,
    notes: 'Name and title confirmed on their OWN leadership page among the corporate directors, not an aggregator guess. Address read on a live company job posting. Name her in the greeting since it is a shared inbox. Her background is HR generalist and talent management, so training and development framing should land. Secondary: Pam Graves, Director of Portfolio and Product Training. ~300 staff.' }],

  ['Big Country Equipment Repair Ltd.', {
    contact_name: 'Connie Olson', contact_role: 'Manager, People and Talent',
    email: 'recruiting@bcer.ca', email_quality: 'role', qualification_score: 8,
    notes: 'CONTACT SWAPPED off the owner: BCER is now 100+ staff, above the threshold where the owner is the right target. Connie Olson is ZoomInfo-only, unconfirmed on their site, so name her carefully. recruiting@ is the right door for an HR pitch among their five departmental inboxes. NOTE: careers run on a Dayforce HCM portal, so a payroll HCM incumbent already exists.' }],

  ['VanMar Constructors Inc.', {
    city: 'Abbotsford BC', qualification_score: 8,
    notes: 'ADDRESS CORRECTION: the BC office is Unit 101B-30701 Simpson Road, ABBOTSFORD, not Langley. Stuart Butcher confirmed on their own team page; his bio is a ready-made hook, joined 2023 as Site Safety Coordinator, promoted to H&S Manager 2025, NEBOSH Diploma and NCSO, described as driven by ongoing professional development. VanMar publishes zero addresses; forms only. One off-site alternate exists, jeffm@vanmarconstructors.com (Jeff Marin, President) via ConstructConnect. Butcher’s address was deliberately NOT constructed from that pattern.' }],

  ['Collicutt Energy Services Corp.', {
    email: 'hr@collicutt.com', email_quality: 'role', qualification_score: 9,
    notes: 'GENERIC BUT DEPARTMENTAL, which is the good kind: published on their careers page as the resume address and routing to Nadine’s own team. Her title is ZoomInfo/TheOrg only; she started Oct 2025 and her LinkedIn headline still surfaces her prior employer Peavey, so confirm before using her name. Holds a CRSP. ~157 staff, CEO Steven Collicutt.' }],

  ['PhysioCare At Home', {
    email: 'care@physiocareathome.com', email_quality: 'role', qualification_score: 7,
    notes: 'REGION-SCOPED INBOX, better than a national info@: care@ serves BC and Alberta while office@ serves NS, NB and ON. Address Heather by name. CONTEXT CORRECTION: this is a NATIONAL in-home senior care company, not a Langley clinic. Above Heather sit Stephen Stow (Managing Director) and Jillian Bergman Stow (Clinical Director), the likely real buyers. Hiring physios in five cities, so onboarding load is live.' }],

  ['Vivo for Healthier Generations Society', {
    email: 'memberservices@vivo.ca', email_quality: 'generic', qualification_score: 7,
    notes: 'FRONT-DESK INBOX, so put Natasha Jones in the subject line or it will not get routed. No individual @vivo.ca address exists anywhere: team, leadership, contact, careers and the annual report PDF all checked, only memberservices@ and donate@ exist. ~65 staff registered charity. CAUTION: apparent CEO transition, Chris Jennings on the leadership page versus Cynthia Watson in archives.' }],

  ['CarePros', {
    qualification_score: 8,
    notes: 'A real personal address exists, lloyd@easyhr.ca, but it is his SIDE CONSULTANCY not CarePros, listed in the ADR Institute of Alberta mediator directory. Pitching CarePros into a personal-business inbox can read as misdirected, so if used, name CarePros explicitly in line one. Safer is info@carepros.ca. The kishuan@carepros.ca string in their page markup is a WordPress author account, not a contact.' }],

  ['Interior Plumbing & Heating Ltd.', {
    email: 'info@iph.ltd', email_quality: 'generic', qualification_score: 8,
    notes: 'NOTE THE MAIL DOMAIN: iph.ltd, which differs from the website domain iphltd.com. They ROT13-obfuscate every address on the site; the careers page decodes to info@iph.ltd and it is explicitly the resume address. Nancy Ikpeama’s title is ZoomInfo only, NOT on their own Meet The Team page. Already COR certified, so credential renewal beats generic HR as the angle.' }],

  ['MPI Oilfield Inc.', {
    email: 'info@mpioilfield.com', email_quality: 'generic', qualification_score: 7,
    notes: 'Only address on a live page. A careers@mpioilfield.com appears in search indexes of three job ads but every one 410s or 403s live, so it is NOT confirmed and should not be used. ANGLE: their Safety Admin ad says the role reports to an HSE Manager and supports an HSE Supervisor and HR Coordinator, so all three functions exist in-house but none is named. Sean Verrier is Majority Partner and President.' }],

  ['In-Line Contracting Ltd.', {
    qualification_score: 6,
    notes: 'NO EMAIL PUBLISHED ANYWHERE. Single-page site, zero email strings in the HTML, reCAPTCHA form only, phone 780-448-9638. The Edmonton Construction Association listing has a Send Email relay that hides the address. Jenna Balog is LinkedIn-only. Best route is phone or the ECA relay, not cold email.' }],

  ['ProSoils Inc.', {
    qualification_score: 7,
    notes: 'Kelsey Grisdale confirmed on their own team page AND the BBB profile as Principal. NO EMAIL EXISTS PUBLICLY: all 16 Wix sitemap URLs crawled, zero mailto links, zero @prosoils.ca strings. Phone or web form only. No HR or safety title exists at the company, which is why GM is correct.' }],
];

(async () => {
  let ok = 0, miss = 0;
  for (const [name, patch] of UPDATES) {
    if (DRY) { console.log(`[dry] ${name}`); ok++; continue; }
    const { data, error } = await supabase.from('cadre_leads').update(patch)
      .eq('business_name', name).select('id');
    if (error) { console.error(`FAIL ${name}: ${error.message}`); continue; }
    if (!data || !data.length) { console.log(`MISS ${name}`); miss++; continue; }
    console.log(`ok   ${name}${patch.email ? '  ' + patch.email : ''}`);
    ok++;
  }
  console.log(`\n${ok} applied, ${miss} unmatched`);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
