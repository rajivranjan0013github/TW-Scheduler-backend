import { ensureDevCertificates } from '../config/ssl.js';

console.log('Generating development SSL certificates for localhost...');
const { certPath, keyPath } = ensureDevCertificates();

if (certPath && keyPath) {
  console.log('Certificate:', certPath);
  console.log('Key:', keyPath);
  console.log('Ready for local HTTPS development on https://localhost');
} else {
  console.error('Failed to create certificates.');
  process.exit(1);
}
