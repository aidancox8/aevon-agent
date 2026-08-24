#!/usr/bin/env node
/**
 * cadre/contacts-prairies.js — apply the AB/SK/MB contact research to cadre_leads.
 *
 * Three published personal emails were found, none of them constructed from a pattern. The best
 * came from a House of Commons committee brief: Advance Paper Box's CFO signed a submission on
 * the CBSA CARM system and the signature block prints his direct address.
 *
 * The agent deliberately left addresses null at Crestline and AgWest even though both publish a
 * visible first-initial-plus-surname convention on their own sites and the databases had the
 * addresses masked. That restraint is correct: a guessed address that bounces damages the
 * sending domain, and this campaign has 82 leads and no track record to spend.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');

const UPDATES = [
  ['MJ Roofing & Supply Ltd.', {
    website: 'https://mjroofing.net', contact_name: 'Nathan Willman', contact_role: 'COO',
    email: 'nathan@mjroofing.net', email_quality: 'personal', qualification_score: 10,
    notes: 'STRONGEST PRAIRIE LEAD. Email published in the Canadian Roofing Contractors Association directory. DOMAIN CHANGED: mjroofing.ca redirects to mjroofing.net, use .net. Founded 1959, commercial flat roofing, 909 Jarvis Ave Winnipeg. Larry Willman CEO, Marc Guzzi CFO. No HR or safety person named publicly.' }],

  ['Advance Paper Box Ltd.', {
    contact_name: 'Yeti Biroue', contact_role: 'Chief Financial Officer',
    email: 'yeti@advancepaperbox.ca', email_quality: 'personal', qualification_score: 9,
    notes: 'Email published in a House of Commons trade committee brief he signed on CBSA CARM; the signature block prints it. CFO not HR, but they publish no HR or safety contact and a packaging council directory lists him as primary contact. ADDRESS CHANGED to 105 Panet Rd Winnipeg. Brief is from 2024, verify he is still there. Do NOT confuse with the US firm on the .com domain.' }],

  ['Heartland Coatings Ltd.', {
    contact_name: 'Trevor Keith', contact_role: 'Manager',
    email: 'tkeith@heartlandcoatings.ca', email_quality: 'personal', qualification_score: 8,
    notes: 'Email from the Canadian Council for Indigenous Business member directory where he is the designated contact, direct line 780-278-8738. Title is vague and the entry may be dated. 11-50 staff so manager level is right. Alternates: Tyler Curry (GM), Ken W. Clark (Shop Operations Supervisor).' }],

  ['Vivo for Healthier Generations Society', {
    website: 'https://www.vivo.ca', contact_name: 'Natasha Jones',
    contact_role: 'Director of Culture & People', city: 'Calgary AB', qualification_score: 9,
    notes: 'BEST ROLE FIT IN THE BATCH, confirmed on two of their own pages. 15+ years senior people leadership, MA Counselling Psychology and MA Organizational Leadership. HOOK: hiring a Culture & People Advisor, so her team is growing. CAUTION: apparent CEO transition, leadership page says Chris Jennings, archives say Cynthia Watson, and a CEO posting is circulating.' }],

  ['Collicutt Energy Services Corp.', {
    contact_name: 'Nadine St. Denis', contact_role: 'Director of Human Resources',
    qualification_score: 9,
    notes: 'Started Oct 2025 so the role is current. Holds a CRSP safety designation, previously VP People and Culture at Peavey Industries. Her LinkedIn headline still surfaces Peavey in search, so confirm employer before using her name. Only hr@collicutt.com is published. ~157 staff.' }],

  ['CarePros', {
    contact_name: 'Lloyd Fischer', contact_role: 'Vice President, People & Culture',
    qualification_score: 9,
    notes: 'Dedicated bio page on their own site (403s to automated fetch but indexed). CPHR Alberta, SHRM-SCP. B Corp, Globe and Mail Top Growing Company 2021-2024, so growth-minded but likely already running HR systems. Others: Charles Wong (CEO), Jody Perry (P&C Coordinator).' }],

  ['In-Line Contracting Ltd.', {
    website: 'https://www.inlinecontracting.ca', contact_name: 'Jenna Balog',
    contact_role: 'Safety Manager', qualification_score: 9,
    notes: 'Website found. CORRECTION: heavy civil, underground utility and road boring since 1982, NOT line painting; the name refers to horizontal boring. Balog has 20+ years OHS, CHSEP, SHEM diploma, so she will understand the credential angle immediately. No email published, contact form only.' }],

  ['Thyssen Mining Construction of Canada Ltd.', {
    contact_name: 'Carmen Firlotte', contact_role: 'Human Resources Manager',
    staff_estimate: 534, qualification_score: 7,
    notes: 'WARNING: their site carries an explicit notice about fraudulent recruiters impersonating their domain, so an HR-themed cold email will get extra scrutiny. Title from RocketReach, corroborated by a US Form 5500 naming her plan administrator. Safety alternates: Richard Bidinost (H&S Coordinator).' }],

  ['RFNOW Inc.', {
    website: 'https://www.rfnow.com', contact_name: 'Lorne Melnyk',
    contact_role: 'VP of Operations', staff_estimate: 150, qualification_score: 8,
    notes: 'Website found. DO NOT TARGET HR: they are actively recruiting a Chief Human Resources Officer, so the seat is vacant or in transition. Rural fibre and wireless ISP, ~119-190 staff including a ~100-person construction crew, appears PE-backed. Only techsupport@rfnow.net is published.' }],

  ['Trellis Society for Community Impact', {
    website: 'https://www.growwithtrellis.ca', contact_name: 'Courtenay Hick',
    contact_role: 'Co-Chief Operating Officer', qualification_score: 7,
    notes: 'Website found. NO HR or People role on their published leadership page, which drops this to the operations tier. TWO Co-COOs, Courtenay Hick and Kim Ledene; check which owns internal operations first. Careers routes to ADP Workforce Now. Large nonprofit, expect procurement-style buying and a slow cycle.' }],

  ['MPI Oilfield Inc.', {
    website: 'https://mpioilfield.com', contact_name: 'Rosslyn Gallant',
    contact_role: 'General Manager', qualification_score: 8,
    notes: 'GM title confirmed on her own LinkedIn and ZoomInfo. A Cindy Kostyshyn appears as HR Coordinator on ZoomInfo ONLY, uncorroborated, so not used. A live Safety Admin posting confirms an HSE Manager, HSE Supervisor and HR Coordinator all exist in-house but none is named publicly. Multi-branch thermal pipelining and SAGD.' }],

  ['Crestline Coach Ltd.', {
    contact_name: 'Trish Catto', contact_role: 'Director, Human Resources',
    qualification_score: 7,
    notes: 'Title from LinkedIn and databases, NOT on their site. DO NOT CONSTRUCT HER EMAIL: their sales page publishes real addresses as first-initial+surname, which makes guessing tempting and wrong. Part of the Demers-Braun-Crestline-Medix group, so HR decisions may not be local. HOOK: hiring both an HR Specialist and a Safety & Quality Administrator.' }],

  ['AgWest Ltd.', {
    contact_name: 'Neil Douglas', contact_role: 'Chief Executive Officer',
    staff_estimate: 50, qualification_score: 8,
    notes: 'AGCO/CLAAS dealer across eight MB and SK branches; ruled out namesakes AgWest Farm Credit and AgWest Commodities. BEST HOOK IN THE BATCH: advertising a Training & Safety Coordinator with no named contact, which suggests the safety function is currently unowned. Site 403s to automated fetch.' }],

  ['ProSoils Inc.', {
    contact_name: 'Kelsey Grisdale', contact_role: 'General Manager (Rose Valley)',
    qualification_score: 8,
    notes: 'Named on their own team page. That page lists 19 people and NONE is HR or safety, so GM is correct. Jeff Prosko is President/owner if you want owner level. ZERO emails published anywhere on the site, phone or contact form only. Family-owned ag retail, four locations.' }],

  ['Aurora Furniture Manufacturing Ltd.', {
    contact_name: 'Ivan Baker', contact_role: 'Operations Manager', qualification_score: 7,
    notes: 'Named in trade press on the Calgary plant opening, but that coverage is ~2 years old and is the only source, so confirm he is still there. Owned by Amax Holding Ltd (Bob Tan, President). Opened with 30 staff, stated plan to reach 150. Hiring an HR Generalist now.' }],

  ['Borealis Fuels & Logistics Ltd.', {
    contact_name: 'Ben Tobber', contact_role: 'President & CEO', qualification_score: 6,
    notes: 'Compromise pick: no HR, safety or HSE person named anywhere. Corporate footprint is split, LinkedIn says Whitehorse YT while the registry address is Calgary. Their TLS certificate chain is broken which blocks fetching. No email addresses at all on the site, phone and web form only.' }],

  ['RG Roadways Ltd.', {
    contact_name: 'Rohit Toor', contact_role: 'Operations Manager',
    staff_estimate: 17, qualification_score: 5,
    notes: 'SMALL: ~11 trucks and 17 drivers, below the useful threshold. Title only from a LinkedIn search headline, page could not be fetched, so employment unverified. Note mail domain is rgroadways.com while the website is .ca. Hook: recently advertising a Safety & Compliance Administrator.' }],

  ['Alliance Maintenance Services', {
    contact_role: 'Director of Maintenance Operations', qualification_score: 5,
    notes: 'SAME PARENT AS HANSEN: created within the Exchange Income Corporation group in 2021, servicing Calm Air, Perimeter and Keewatin Air, so HR is likely decided at portal.exchangeincomecorp.ca. ~33 staff. NO named decision-maker anywhere. The one non-generic address, ddelf@alliance-maintenance.net, sits on a posting reporting to the Director of Maintenance Operations, so it is probably that person, but the name is not confirmed. Mail domain is .net, website is .ca.' }],
];

(async () => {
  let ok = 0, miss = 0;
  for (const [name, patch] of UPDATES) {
    if (DRY) { console.log(`[dry] ${name}`); ok++; continue; }
    const { data, error } = await supabase.from('cadre_leads').update(patch)
      .eq('business_name', name).select('id');
    if (error) { console.error(`FAIL ${name}: ${error.message}`); continue; }
    if (!data || !data.length) { console.log(`MISS ${name}`); miss++; continue; }
    console.log(`ok   ${name}${patch.contact_name ? ' -> ' + patch.contact_name : ''}${patch.email ? '  ' + patch.email : ''}`);
    ok++;
  }
  console.log(`\n${ok} applied, ${miss} unmatched`);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
