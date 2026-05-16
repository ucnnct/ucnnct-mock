export type LoginForm = {
  action: URL;
  fields: Record<string, string>;
};

export function parseLoginForm(html: string, baseUrl: URL): LoginForm {
  const formMatch = html.match(/<form[^>]+id="kc-form-login"[^>]+action="([^"]+)"/i);
  if (!formMatch?.[1]) {
    throw new Error('Unable to parse Keycloak login form action');
  }

  const action = new URL(decodeHtml(formMatch[1]), baseUrl);
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input\b[^>]*name="([^"]+)"[^>]*>/gi)) {
    const rawName = match[1];
    if (!rawName) {
      continue;
    }

    const valueMatch = match[0].match(/value="([^"]*)"/i);
    fields[decodeHtml(rawName)] = decodeHtml(valueMatch?.[1] ?? '');
  }
  return { action, fields };
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}
