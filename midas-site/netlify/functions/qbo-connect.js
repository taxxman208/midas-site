exports.handler = async function () {
  const clientId = process.env.QBO_CLIENT_ID;
  const redirectUri = process.env.QBO_REDIRECT_URI;
  const appBaseUrl = process.env.PUBLIC_SITE_URL || '';

  if (!clientId || !redirectUri) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Missing QBO_CLIENT_ID or QBO_REDIRECT_URI environment variables.'
    };
  }

  const state = Buffer.from(JSON.stringify({ ts: Date.now(), appBaseUrl })).toString('base64url');
  const scopes = encodeURIComponent('com.intuit.quickbooks.accounting');
  const authorizeUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${encodeURIComponent(clientId)}&response_type=code&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;

  return {
    statusCode: 302,
    headers: { Location: authorizeUrl },
    body: ''
  };
};
