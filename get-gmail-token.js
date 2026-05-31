/**
 * get-gmail-token.js
 * One-time helper: opens a browser, you approve access as aidan@aevon.ca,
 * and it prints a refresh token to paste into .env as GMAIL_OAUTH_REFRESH_TOKEN.
 *
 * Run once locally:  node get-gmail-token.js
 * After you have the refresh token, you never need this script again.
 *
 * Requires in .env:
 *   GMAIL_OAUTH_CLIENT_ID
 *   GMAIL_OAUTH_CLIENT_SECRET
 */

require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');

const CLIENT_ID = process.env.GMAIL_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_OAUTH_CLIENT_SECRET;
const PORT = 4571;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET || CLIENT_SECRET.includes('PASTE_')) {
    throw new Error('Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in .env first.');
  }

  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force a refresh token every time
    scope: SCOPES,
  });

  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      if (err) {
        res.end(`Auth failed: ${err}. You can close this tab.`);
        server.close();
        return reject(new Error(err));
      }
      if (code) {
        res.end('Authorized. You can close this tab and return to the terminal.');
        server.close();
        resolve(code);
      }
    });
    server.listen(PORT, () => {
      console.log('\n1. Open this URL in your browser (sign in as aidan@aevon.ca):\n');
      console.log('   ' + authUrl + '\n');
      console.log('2. Approve access. You will be redirected to a localhost page.\n');
      console.log('Waiting for authorization...\n');
    });
  });

  const code = await codePromise;
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    console.error('\nNo refresh token returned. Revoke the app at');
    console.error('https://myaccount.google.com/permissions and run this again.');
    process.exit(1);
  }

  console.log('\n=== SUCCESS ===');
  console.log('Paste this line into .env:\n');
  console.log(`GMAIL_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  console.log('Then add the same value as a GitHub secret named GMAIL_OAUTH_REFRESH_TOKEN.');
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
