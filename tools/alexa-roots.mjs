// Regenerates workers/alexa-roots.js from Node's bundled Mozilla CA store:
// the Amazon Trust Services roots that Alexa's request-signing certificates chain to.
//   node tools/alexa-roots.mjs
import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
import tls from 'node:tls';
import fs from 'node:fs';

const pemToDer = (pem) => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
const cn = (name) => name.map((rdn) => rdn.map((a) => (a.type === '2.5.4.3' ? String(a.value.printableString ?? a.value.utf8String ?? a.value) : '')).join('')).join('');
const picked = tls.rootCertificates.filter((pem) =>
  /Amazon Root CA [1-4]|Starfield Services Root Certificate Authority - G2/.test(cn(AsnConvert.parse(pemToDer(pem), Certificate).tbsCertificate.subject)));
const body = `// Root certificates Alexa request signatures chain to (Amazon Trust Services), taken
// from Node ${process.version}'s bundled Mozilla CA store by tools/alexa-roots.mjs.

export const ALEXA_ROOTS = [
${picked.map((p) => `  \`${p.trim()}\`,`).join('\n')}
];
`;
fs.writeFileSync(new URL('../workers/alexa-roots.js', import.meta.url), body);
console.log(`${picked.length} roots written`);
