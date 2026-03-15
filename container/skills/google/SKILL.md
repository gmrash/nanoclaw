---
name: google
description: Access Gmail, Google Calendar, Google Docs, and Google Drive for gmrash@gmail.com. Use whenever the user asks about emails, calendar events, Google documents, or Drive files.
allowed-tools: Bash(node:*)
---

# Google Workspace Access

## Credentials
Stored at: `/workspace/group/google-credentials.json`

If the file doesn't exist, tell the user that Google credentials need to be set up (OAuth flow).

## Usage

Always use the googleapis npm package at `/home/node/node_modules/googleapis`.

### Setup auth client (use in every script):
```js
const { google } = require('/home/node/node_modules/googleapis');
const creds = require('/workspace/group/google-credentials.json');

const oauth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, creds.redirect_uri);
oauth2Client.setCredentials({ access_token: creds.access_token, refresh_token: creds.refresh_token });
```

### Gmail
```js
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
// List messages
await gmail.users.messages.list({ userId: 'me', maxResults: 10, q: 'is:unread' });
// Get message
await gmail.users.messages.get({ userId: 'me', id: MESSAGE_ID, format: 'full' });
// Send email
await gmail.users.messages.send({ userId: 'me', requestBody: { raw: base64EncodedEmail } });
```

### Calendar
```js
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
// List events
await calendar.events.list({ calendarId: 'primary', timeMin: new Date().toISOString(), maxResults: 10, singleEvents: true, orderBy: 'startTime' });
// Create event
await calendar.events.insert({ calendarId: 'primary', requestBody: { summary, start: { dateTime }, end: { dateTime } } });
```

### Google Docs
```js
const docs = google.docs({ version: 'v1', auth: oauth2Client });
// Get document
await docs.documents.get({ documentId: DOC_ID });
// Create document
await docs.documents.create({ requestBody: { title: 'New Doc' } });
```

### Google Drive
```js
const drive = google.drive({ version: 'v3', auth: oauth2Client });
// List files
await drive.files.list({ pageSize: 10, fields: 'files(id, name, mimeType)' });
```

## Tips
- The access token auto-refreshes via refresh_token
- User email: gmrash@gmail.com
- After any API call, if tokens were refreshed, save updated credentials back to `/workspace/group/google-credentials.json`
- Credentials are per-group — each channel has its own file. If missing, the user needs to re-authenticate.
