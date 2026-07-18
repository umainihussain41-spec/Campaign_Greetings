import 'dotenv/config';
import path from 'node:path';

function required(name) {
  const v = process.env[name];
  if (!v) console.warn(`[config] Missing env ${name} - related features will fail until it is set.`);
  return v || '';
}

const dataDir = path.resolve(process.env.DATA_DIR || './data');

export const config = {
  port: Number(process.env.PORT || 3000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  dataDir,
  audioDir: path.join(dataDir, 'audio'),

  exotel: {
    sid: required('EXOTEL_SID'),
    apiKey: required('EXOTEL_API_KEY'),
    apiToken: required('EXOTEL_API_TOKEN'),
    subdomain: process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com',
    callerId: process.env.EXOTEL_CALLER_ID || '',
    appId: process.env.EXOTEL_APP_ID || '',
    // Country code prepended when normalizing recipient numbers to E.164
    // (Exotel's Contacts API rejects anything else). Default: India (91).
    countryCode: (process.env.EXOTEL_COUNTRY_CODE || '91').replace(/\D/g, ''),
  },

  webhookToken: process.env.WEBHOOK_TOKEN || '',
};

// The flow URL a campaign points at. Its Greeting/Connect applet calls
// our /exotel/audio webhook, which returns the currently-selected MP3.
export function flowUrl() {
  return `http://my.exotel.com/${config.exotel.sid}/exoml/start_voice/${config.exotel.appId}`;
}

export function audioUrl(fileName) {
  return `${config.publicBaseUrl}/audio/${fileName}`;
}
