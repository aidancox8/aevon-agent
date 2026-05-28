/**
 * dedup-emails.js
 * Finds leads sharing the same email address, keeps the one with the highest
 * qualification score (ties broken by created_at ascending), deletes the rest.
 *
 * Usage: node dedup-emails.js
 *        node dedup-emails.js --dry-run   (print what would be deleted)
 */

require('dotenv').config();
const { Client } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  await client.connect();

  // Find all emails that appear more than once
  const { rows: dupes } = await client.query(`
    SELECT email, COUNT(*) AS cnt
    FROM leads
    WHERE email IS NOT NULL
    GROUP BY email
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);

  if (dupes.length === 0) {
    console.log('No duplicate emails found.');
    await client.end();
    return;
  }

  console.log(`Found ${dupes.length} email(s) with duplicates:\n`);

  let totalDeleted = 0;

  for (const { email, cnt } of dupes) {
    const { rows: leads } = await client.query(`
      SELECT id, business_name, qualification_score, status, created_at
      FROM leads
      WHERE email = $1
      ORDER BY qualification_score DESC NULLS LAST, created_at ASC
    `, [email]);

    const keep = leads[0];
    const remove = leads.slice(1);

    console.log(`  ${email} (${cnt} copies)`);
    console.log(`    keep:   [${keep.id}] ${keep.business_name} (score ${keep.qualification_score}, status ${keep.status})`);
    for (const r of remove) {
      console.log(`    delete: [${r.id}] ${r.business_name} (score ${r.qualification_score}, status ${r.status})`);
    }

    if (!DRY_RUN) {
      const ids = remove.map(r => r.id);
      await client.query(`DELETE FROM leads WHERE id = ANY($1::uuid[])`, [ids]);
      totalDeleted += ids.length;
    }
  }

  if (DRY_RUN) {
    console.log('\nDry run — nothing deleted.');
  } else {
    console.log(`\nDeleted ${totalDeleted} duplicate lead(s).`);
  }

  await client.end();
}

run().catch(async err => {
  console.error('Fatal:', err.message);
  await client.end();
  process.exit(1);
});
