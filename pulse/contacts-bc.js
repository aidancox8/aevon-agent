#!/usr/bin/env node
/**
 * pulse/contacts-bc.js — apply the BC contact research to pulse_leads.
 *
 * Two kinds of finding here and the second matters more than the first.
 *
 * NAMES: a person with a title beats a generic inbox, because the whole premise of this campaign
 * is quoting someone's own job ad back to them. That lands very differently addressed to the
 * safety manager than to info@.
 *
 * DISQUALIFIERS: four companies turned out to be the wrong target entirely, and every one would
 * have looked fine on the lead list. Guardteck sits under a 3,500-staff parent that already runs
 * Dayforce. Hansen was acquired by a TSX-listed parent that dictates HR systems. Five Corners
 * centralises HR at Donald's Fine Foods. Avina is 10-19 staff on temporary foreign harvest
 * labour. Finding these BEFORE sending is worth more than the names.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');

/** [businessName, patch] */
const UPDATES = [
  ['Global Rigging and Transport', {
    website: 'https://www.globalrigging.com/', contact_name: 'Andrew Johnson',
    contact_role: 'Operations Manager', email: 'a.johnson@globalrigging.com',
    email_quality: 'personal', qualification_score: 10,
    notes: 'BEST CONTACT ON THE LIST. Email published on their own contact page, not an aggregator and not a guessed pattern. Runs the Canadian operation from 19399 96 Ave Surrey. US parent in Virginia Beach. Rigging tickets, crane certs and CWB welder credentials all expire.' }],

  ['Union Gospel Mission', {
    contact_name: 'Stacey Reyes', contact_role: 'Vice President, People Excellence',
    qualification_score: 9,
    notes: 'Best-fit title found anywhere: People Excellence is UGM’s name for HR and she is on the executive team. Prior roles Manager People and Culture at Fine Choice Foods, Manager HR at Bird Construction. ugm.ca/leadership 403s to automated fetch, so confirm her title in a browser first. Do NOT guess her address.' }],

  ['VanMar Constructors Inc.', {
    website: 'https://bc.vanmarconstructors.com/', contact_name: 'Stuart Butcher',
    contact_role: 'Safety Manager', city: 'Langley BC', qualification_score: 8,
    notes: 'USE THE BC SUBDOMAIN, not the Ontario head office site. Escalation path: Shawn Vandergaag (Project and Safety Director), then Jeff Marin (President). A safety director AND a safety manager on a 23-person office means EHS documentation is taken seriously.' }],

  ['Taproot Community Support Services Ltd.', {
    contact_name: 'Sharla Drebit', contact_role: 'Chief Operating Officer', qualification_score: 9,
    notes: 'Their team page lists ~29 people and NO HR title, which is itself the pitch. Karina Kolosoff Botelho (Senior HR Generalist) exists via TheOrg and is the user-level champion, but COO is the buyer. Nine locations across BC and Alberta. Opener worth using: first employee-ownership trust in Canadian social services.' }],

  ['Interior Plumbing & Heating Ltd.', {
    website: 'https://iphltd.com/', contact_name: 'Nkechinyere (Nancy) Ikpeama',
    contact_role: 'Manager, Human Resources', qualification_score: 9,
    notes: 'Title from ZoomInfo, not on their own site, so verify. Fallback is Chris Owen (Owner and President). Family-owned 70+ years, 200+ staff, already COR-certified, so credential renewal is the sharper angle than generic HR.' }],

  ['Caliber Projects Ltd.', {
    contact_name: 'Tim Gonsalves', contact_role: 'Manager, People and Culture',
    qualification_score: 9,
    notes: 'Corroborated by a podcast appearance running their leadership development programme, not just an aggregator. Their own public identity is "Building People and Processes; we just happen to do Construction", which is an unusually good fit for an HR pitch. Founder is Justin Bontkes.' }],

  ['Surespan Construction Ltd.', {
    contact_name: 'Mike Maurice', contact_role: 'Corporate Health & Safety Manager',
    qualification_score: 9,
    notes: 'Corporate-level, which is the right altitude across multiple Surespan entities. TIMING: hiring an Assistant Safety Manager whose posted duties are literally the pitch, claims management, onboarding, training compliance, workforce readiness.' }],

  ['Big Country Equipment Repair Ltd.', {
    website: 'https://bcer.ca/', contact_name: 'Spencer Harrison', contact_role: 'Owner and Founder',
    staff_estimate: 100, qualification_score: 9,
    notes: 'Website found. 100+ staff and 35+ service trucks, not the 60 first estimated. TIMING: hiring an HR Generalist right now, so the function is being built out as we speak. Deployed tradespeople on remote client sites means ticket renewal is live pain.' }],

  ['PhysioCare At Home', {
    website: 'https://physiocareathome.com/', contact_name: 'Heather Koerber',
    contact_role: 'Clinical Operations Manager', qualification_score: 8,
    notes: 'Names from their own BC team page, so titles are reliable. Alternatives: Stephen Stow (Managing Director), Lesley d’Apollonia (Director of Community Care). CAUTION: multi-province with a separate Nova Scotia arm, so Langley is a branch not a standalone.' }],

  ['North Mountain Construction', {
    website: 'https://northmountainconstruction.ca/', contact_name: 'Gabe Tyler',
    contact_role: 'Managing Director', staff_estimate: 50, qualification_score: 8,
    notes: '17 named leaders published and NOT ONE is HR or safety, which is the sales angle. Two offices (Nelson and Fernie), just over 50 staff, $85M in active projects. Alternatives: Lynn Newman (Financial Director), Kerri Larson (Director, Construction).' }],

  ['Trillium Project Management Ltd.', {
    contact_name: 'David Hamilton', contact_role: 'President', staff_estimate: 35,
    notes: 'Names via RocketReach, not their own site. Small owner-led consultancy despite a reported 51-200 headcount, so President is the right target.' }],

  ['Footbridge Centre for Integrated Orthopaedic Care', {
    website: 'https://www.footbridgeclinic.com/', contact_role: 'Managing Director',
    notes: 'Website found. Their own SmartRecruiters posting says the Patient Care Coordinator reports to a "Managing Director", so the title exists but no name is published. Team pages list clinicians only. Phone and ask for the Managing Director by title.' }],

  ['Segra International Corp', {
    website: 'https://www.segra-intl.com/', contact_name: 'Jamie Blundell',
    contact_role: 'Chief Executive Officer', city: 'Richmond BC', qualification_score: 6,
    notes: 'CORRECTED: the site is segra-intl.com, and corporate is Richmond BC, not Kelowna. Kelowna came from acquiring Klonetics Plant Science in May 2025. segra.com is an unrelated US telecom, ignore anything from it. Management page may predate the acquisition, so verify leadership before contacting.' }],

  ['Cap West Forming Ltd', {
    qualification_score: 6,
    notes: 'PROCEED WITH CARE. WorkSafeBC fined them $28,150.47 for a shoring post falling from the 62nd level at Gilmore Place, so they may be defensive about anything safety-adjacent. Their own site is a half-finished template: the founder message is still Lorem ipsum and the testimonials are stock names.' }],

  ['MacKay Contracting Ltd.', {
    qualification_score: 6,
    notes: 'Site is live but marked SITE UNDER CONSTRUCTION with no team content. Address the Cranbrook head office (1600A Theatre Road), not Sparwood. TIMING: recruiting a Safety Advisor who will own OHS compliance; that person is the buyer once hired.' }],

  // ---- Disqualified or heavily downgraded ----
  ['Guardteck Security', {
    status: 'dont_contact', qualification_score: 2,
    notes: 'DISQUALIFIED. Operates under Kandor Management Corporation, ~3,500 staff across Guardteck, Everclean and Kendrix. HR is centralised at Kandor and they ALREADY RUN DAYFORCE. The buying decision is not at Guardteck and displacing Dayforce at 3,500 seats is not a first sale. Named leaders if ever relevant: Chris Gerela (COO), Seth Fruson (CEO).' }],

  ['Hansen Industries Ltd', {
    website: 'https://hansenindustries.com/', qualification_score: 4,
    notes: 'CORRECTION: the website is hansenindustries.com. hanind.com is their EMAIL domain only, which is why the off-domain guard cleared info@hanind.com. MATERIAL RISK: acquired by Exchange Income Corporation (TSX: EIC) in April 2023 for $42.5M and now brands as "An EIC Company". Parent companies usually dictate HR systems, so confirm autonomy before spending time.' }],

  ['Five Corners Meat Company Ltd.', {
    qualification_score: 4,
    notes: 'HR IS CENTRALISED AT THE PARENT. No site of its own; Donald’s Fine Foods (donaldsfinefoods.com) runs four plants across BC and SK and posts an HR Manager role reporting to a Director HR. The real buyer is that Director HR, unnamed. Beware: fivecornersmeat-ca.com does not resolve, and Yellow Pages files the address under Vantage Foods.' }],

  ['Avina Fresh Produce Ltd', {
    status: 'dont_contact', qualification_score: 2,
    notes: 'DEPRIORITISED. No website. Operating entity looks like Avina Fresh Mushrooms Inc., roughly 10-19 employees on a temporary foreign worker harvesting workforce, which is a weak fit for an HR platform. Also WorkSafeBC fines reported at these mushroom operations.' }],
];

(async () => {
  let ok = 0, miss = 0;
  for (const [name, patch] of UPDATES) {
    if (DRY) { console.log(`[dry] ${name} -> ${Object.keys(patch).join(', ')}`); ok++; continue; }
    const { data, error } = await supabase.from('pulse_leads').update(patch)
      .eq('business_name', name).select('id');
    if (error) { console.error(`FAIL ${name}: ${error.message}`); continue; }
    if (!data || !data.length) { console.log(`MISS ${name} (no row matched)`); miss++; continue; }
    const flag = patch.status === 'dont_contact' ? 'DISQUALIFIED ' : '';
    console.log(`ok   ${flag}${name}${patch.contact_name ? ' -> ' + patch.contact_name : ''}`);
    ok++;
  }
  console.log(`\n${ok} applied, ${miss} unmatched`);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
