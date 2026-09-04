import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CERTS_DIR = path.resolve(__dirname, '../../certs');
const DEFAULT_CERT_FILE = path.join(DEFAULT_CERTS_DIR, 'localhost.pem');
const DEFAULT_KEY_FILE = path.join(DEFAULT_CERTS_DIR, 'localhost-key.pem');

/**
 * Generate a self-signed certificate for localhost development if not already present.
 */
export function ensureDevCertificates() {
  const certPath = process.env.SSL_CRT_FILE || DEFAULT_CERT_FILE;
  const keyPath = process.env.SSL_KEY_FILE || DEFAULT_KEY_FILE;

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { certPath, keyPath };
  }

  const certDir = path.dirname(certPath);
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }

  console.log('🔒 Generating local SSL development certificates for localhost...');
  try {
    const opensslCmd = `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`;
    execSync(opensslCmd, { stdio: 'pipe' });
    console.log(`✅ Local SSL certificate generated successfully in: ${certDir}`);
    return { certPath, keyPath };
  } catch (err) {
    console.warn(`⚠️ Failed to generate local SSL certificates with OpenSSL: ${err.message}`);
    return { certPath: null, keyPath: null };
  }
}

/**
 * Get SSL configuration options for https.createServer.
 */
export function getHttpsOptions() {
  const isHttps = process.env.HTTPS === 'true' || process.env.USE_HTTPS === 'true';
  if (!isHttps) {
    return null;
  }

  const { certPath, keyPath } = ensureDevCertificates();
  if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      return {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      };
    } catch (err) {
      console.error(`❌ Failed to read SSL certificate files: ${err.message}`);
      return null;
    }
  }

  return null;
}

/**
 * Creates either an HTTPS or HTTP server based on environment configuration.
 */
export function createAppServer(app) {
  const sslOptions = getHttpsOptions();
  if (sslOptions) {
    return {
      server: https.createServer(sslOptions, app),
      isHttps: true,
      protocol: 'https',
    };
  }

  return {
    server: http.createServer(app),
    isHttps: false,
    protocol: 'http',
  };
}
