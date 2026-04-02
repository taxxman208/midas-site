const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

exports.handler = async function (event) {
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const redirectUri = process.env.QBO_REDIRECT_URI;
  const code = event.queryStringParameters?.code;
  const realmId = event.queryStringParameters?.realmId;

  if (!clientId || !clientSecret || !redirectUri) {
    return html('Missing QBO_CLIENT_ID, QBO_CLIENT_SECRET, or QBO_REDIRECT_URI environment variables.');
  }

  if (!code || !realmId) {
    return html('Missing code or realmId in callback URL.');
  }

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    });

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: body.toString()
    });

    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      return html(`Token exchange failed: ${escapeHtml(JSON.stringify(tokenJson, null, 2))}`);
    }

    const refreshToken = tokenJson.refresh_token;
    const accessToken = tokenJson.access_token;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: `<!doctype html>
<html><head><meta charset="utf-8"><title>QuickBooks Connected</title>
<style>body{font-family:Arial,sans-serif;background:#0b0b0d;color:#f5f5f5;padding:40px;line-height:1.6}pre{background:#151519;border:1px solid #2a2a36;padding:16px;overflow:auto}code{color:#f0c866}h1{margin-top:0}</style>
</head><body>
<h1>QuickBooks connected</h1>
<p>Copy these values into your Netlify environment variables:</p>
<pre>QBO_REALM_ID=${escapeHtml(realmId)}
QBO_REFRESH_TOKEN=${escapeHtml(refreshToken)}</pre>
<p>You can ignore the access token. It expires quickly. Keep the refresh token private.</p>
<p>After you save those variables in Netlify, trigger a new deploy.</p>
</body></html>`
    };
  } catch (err) {
    return html(`Callback error: ${escapeHtml(err.message || String(err))}`);
  }
};

function html(message) {
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><html><body><pre>${message}</pre></body></html>`
  };
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
