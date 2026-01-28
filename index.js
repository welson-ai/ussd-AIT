/**
 * TransitLink USSD Handler (Node.js/Express)
 *
 * Responsibilities:
 * - Handle Africa's Talking USSD callbacks via POST /ussd
 * - Manage session state in Supabase (level, company, feature, data)
 * - Provide modular menu flows and proper CON/END responses
 *
 * Requirements:
 * - ENV: SUPABASE_URL, SUPABASE_KEY (service role), PORT
 */
import 'dotenv/config';
import dotenv from 'dotenv';
import fs from 'fs';
import { parse as dotenvParse } from 'dotenv';
import africastalking from 'africastalking';
dotenv.config();
try {
  const envPath = process.env.ENV_PATH || `${process.cwd()}/.env`;
  if (fs.existsSync(envPath)) {
    const parsed = dotenvParse(fs.readFileSync(envPath));
    for (const [k, v] of Object.entries(parsed)) {
      if (!Object.prototype.hasOwnProperty.call(process.env, k)) {
        process.env[k] = v;
      }
    }
  }
} catch {}
import express from 'express';
import { createClient } from '@supabase/supabase-js';

// Create Express app
const app = express();
app.use(express.urlencoded({ extended: false }));

const env = (name) => (process.env[name] || '').trim();
const SUPABASE_URL =
  env('SUPABASE_URL') ||
  env('NEXT_PUBLIC_SUPABASE_URL') ||
  '';
const SUPABASE_KEY =
  env('SUPABASE_SERVICE_ROLE_KEY') ||
  env('SUPABASE_SECRET_KEY') ||
  env('SUPABASE_KEY') ||
  ''; // do NOT use anon/publishable in production server
if (!SUPABASE_URL || !SUPABASE_KEY) {
  // Do not start without required env
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Repositories
 * Encapsulate DB queries for sessions, companies, and routes
 */
const SessionsRepo = {
  async get(sessionId) {
    const { data, error } = await supabase
      .from('ussd_sessions')
      .select('*')
      .eq('session_id', sessionId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  },
  async upsert({ sessionId, phoneNumber, level, companyId, feature, data }) {
    const payload = {
      session_id: sessionId,
      phone_number: phoneNumber,
      level,
      company_id: companyId,
      feature,
      data: JSON.stringify(data || {}),
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('ussd_sessions')
      .upsert(payload, { onConflict: 'session_id' });
    if (error) throw error;
  },
  async del(sessionId) {
    const { error } = await supabase
      .from('ussd_sessions')
      .delete()
      .eq('session_id', sessionId);
    if (error) throw error;
  },
};

const CompaniesRepo = {
  async all() {
    const { data, error } = await supabase
      .from('companies')
      .select('id,name,contact_number')
      .order('id', { ascending: true });
    if (error) throw error;
    return data || [];
  },
  async find(id) {
    const { data, error } = await supabase
      .from('companies')
      .select('id,name,contact_number')
      .eq('id', id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  },
};

const RoutesRepo = {
  async byCompany(companyId) {
    const { data, error } = await supabase
      .from('routes')
      .select('id,origin,destination,fare,departure_times,company_id')
      .eq('company_id', companyId)
      .order('id', { ascending: true });
    if (error) throw error;
    return data || [];
  },
};

/**
 * Helpers: USSD text normalization and menu rendering
 */
function normalizeSelections(text) {
  if (!text) return [];
  const parts = text.split('*').filter(Boolean);
  const stack = [];
  for (const p of parts) {
    if (p === '0') {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(p);
  }
  return stack;
}

function renderMainMenu(companies) {
  let out = 'Welcome to TransitLink\n';
  let i = 1;
  for (const c of companies) {
    out += `${i}. ${c.name}\n`;
    i++;
  }
  return out.trimEnd();
}

function renderCompanyMenu(company) {
  return [
    `${company.name}`,
    '1. Check Routes & Fares',
    '2. Book a Bus',
    '3. Report a Case',
    '4. Lost & Found',
    '5. Give Feedback',
    '0. Back to Main Menu',
  ].join('\n');
}

function renderRoutesAndFares(routes) {
  if (!routes || routes.length === 0) {
    return 'No routes available at this time.';
  }
  return routes
    .map((r) => `${r.origin}-${r.destination} (${r.fare} KES)`)
    .join('\n');
}

const AT_USERNAME = env('AT_USERNAME') || '';
const AT_API_KEY = env('AT_API_KEY') || '';
const AT_SENDER_ID = env('AT_SENDER_ID') || '';
let atSMS = null;
if (AT_USERNAME && AT_API_KEY) {
  const atClient = africastalking({ apiKey: AT_API_KEY, username: AT_USERNAME });
  atSMS = atClient.SMS;
}
async function sendSMS(to, message) {
  if (!atSMS) return false;
  try {
    const result = await atSMS.send({ to: [to], message, from: AT_SENDER_ID || undefined });
    return !!result;
  } catch {
    return false;
  }
}
/**
 * Feature flows
 */
function handleBooking(selections, routes, sessionData) {
  const step = selections.length - 1; // starting at feature selection
  if (step === 1) {
    if (!routes || routes.length === 0) {
      return ['No routes available to book.', true];
    }
    let out = 'Select a route:\n';
    let i = 1;
    for (const r of routes) {
      out += `${i}. ${r.origin}-${r.destination} (${r.fare} KES)\n`;
      i++;
    }
    out += '0. Back';
    return [out.trimEnd(), false];
  }
  if (step === 2) {
    const choice = selections[2];
    const idx = parseInt(choice, 10);
    if (!(idx >= 1 && idx <= routes.length)) {
      return ['Invalid selection. Enter a valid route number.\n0. Back', false];
    }
    const selected = routes[idx - 1];
    sessionData.booking_route = selected;
    return ['Enter number of seats:\n0. Back', false];
  }
  if (step === 3) {
    const seats = parseInt(selections[3] || '0', 10);
    if (!Number.isFinite(seats) || seats <= 0) {
      return ['Invalid seats. Enter a positive number:\n0. Back', false];
    }
    sessionData.seats = seats;
    const r = sessionData.booking_route;
    const total = seats * parseInt(String(r.fare), 10);
    const ref = 'TL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const smsMessage =
      `TransitLink: Booking confirmed!\n` +
      `${r.origin} -> ${r.destination}\n` +
      `Seats: ${seats}\n` +
      `Total: ${total} KES\n` +
      `Ref: ${ref}`;
    const msg =
      `Booking confirmed:\n` +
      `${r.origin} -> ${r.destination}\n` +
      `Seats: ${seats}\n` +
      `Total: ${total} KES\n` +
      `Ref: ${ref}\n` +
      `Thank you for using TransitLink!`;
    return [msg, true, { sms: smsMessage }];
  }
  return ['Unexpected step. Returning to main menu.', true];
}

function handleReportCase(selections, sessionData) {
  const step = selections.length - 1;
  if (step === 1) {
    return ['Describe the case:\n0. Back', false];
  }
  if (step === 2) {
    sessionData.report = selections[2] || '';
    const ref = 'TL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const smsMessage =
      `TransitLink: Report received.\n` +
      `Ref: ${ref}\n` +
      `We will investigate and respond within 24 hours.`;
    return [`Thanks. Your report has been received.\nRef: ${ref}`, true, { sms: smsMessage }];
  }
  return ['Unexpected step. Ending session.', true];
}

function handleLostFound(selections, sessionData) {
  const step = selections.length - 1;
  if (step === 1) {
    return ['Describe the item:\n0. Back', false];
  }
  if (step === 2) {
    sessionData.lost_item = selections[2] || '';
    const ref = 'TL-LOST-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const smsMessage =
      `TransitLink: Lost item reported.\n` +
      `Item: ${selections[2]}\n` +
      `Ref: ${ref}\n` +
      `We will contact you if found.`;
    return ['Thanks. We will contact you if a match is found.', true, { sms: smsMessage }];
  }
  return ['Unexpected step. Ending session.', true];
}

function handleFeedback(selections, sessionData) {
  const step = selections.length - 1;
  if (step === 1) {
    return ['Rate 1-5:\n0. Back', false];
  }
  if (step === 2) {
    const rating = parseInt(selections[2] || '0', 10);
    if (!(rating >= 1 && rating <= 5)) {
      return ['Invalid rating. Enter 1-5:\n0. Back', false];
    }
    sessionData.rating = rating;
    return ['Enter feedback comment:\n0. Back', false];
  }
  if (step === 3) {
    sessionData.comment = selections[3] || '';
    const smsMessage =
      `TransitLink: Thank you for your feedback!\n` +
      `Rating: ${sessionData.rating}/5\n` +
      `Your input helps us improve service.`;
    return ['Thanks for your feedback!', true, { sms: smsMessage }];
  }
  return ['Unexpected step. Ending session.', true];
}

/**
 * Controller
 */
async function handleUssd(req, res) {
  res.type('text/plain');
  const sessionId = req.body.sessionId || '';
  const phoneNumber = req.body.phoneNumber || '';
  const text = req.body.text || '';

  const selections = normalizeSelections(text);
  const companies = await CompaniesRepo.all();
  const level = selections.length;

  // Level 0: Main menu
  if (level === 0) {
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: 0,
      companyId: null,
      feature: null,
      data: {},
    });
    return res.send(`CON ${renderMainMenu(companies)}`);
  }

  // Level 1: Company selected
  const companyIdx = parseInt(selections[0], 10);
  if (!(companyIdx >= 1 && companyIdx <= companies.length)) {
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: 0,
      companyId: null,
      feature: null,
      data: {},
    });
    return res.send(`CON Invalid selection. Try again.\n${renderMainMenu(companies)}`);
  }
  const company = companies[companyIdx - 1];
  const companyId = parseInt(String(company.id), 10);

  if (level === 1) {
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: 1,
      companyId,
      feature: null,
      data: {},
    });
    return res.send(`CON ${renderCompanyMenu(company)}`);
  }

  // Level 2+: Feature selected
  const featureIdx = parseInt(selections[1] || '0', 10);
  const featureMap = {
    1: 'routes',
    2: 'booking',
    3: 'report',
    4: 'lost_found',
    5: 'feedback',
  };
  const feature = featureMap[featureIdx] || null;
  if (!feature) {
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: 1,
      companyId,
      feature: null,
      data: {},
    });
    return res.send(`CON Invalid selection. Try again.\n${renderCompanyMenu(company)}`);
  }

  const data = {};

  if (feature === 'routes') {
    const routes = await RoutesRepo.byCompany(companyId);
    const resp = renderRoutesAndFares(routes);
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: 2,
      companyId,
      feature,
      data,
    });
    await SessionsRepo.del(sessionId);
    return res.send(`END ${resp}`);
  }

  if (feature === 'booking') {
    const routes = await RoutesRepo.byCompany(companyId);
    const [resp, end, extra] = handleBooking(selections, routes, data);
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: end ? 4 : level,
      companyId,
      feature,
      data,
    });
    if (end) {
      if (extra && extra.sms) {
        await sendSMS(phoneNumber, extra.sms);
      }
      await SessionsRepo.del(sessionId);
      return res.send(`END ${resp}`);
    }
    return res.send(`CON ${resp}`);
  }

  if (feature === 'report') {
    const [resp, end, extra] = handleReportCase(selections, data);
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: end ? 3 : level,
      companyId,
      feature,
      data,
    });
    if (end) {
      if (extra && extra.sms) {
        await sendSMS(phoneNumber, extra.sms);
      }
      await SessionsRepo.del(sessionId);
      return res.send(`END ${resp}`);
    }
    return res.send(`CON ${resp}`);
  }

  if (feature === 'lost_found') {
    const [resp, end, extra] = handleLostFound(selections, data);
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: end ? 3 : level,
      companyId,
      feature,
      data,
    });
    if (end) {
      if (extra && extra.sms) {
        await sendSMS(phoneNumber, extra.sms);
      }
      await SessionsRepo.del(sessionId);
      return res.send(`END ${resp}`);
    }
    return res.send(`CON ${resp}`);
  }

  if (feature === 'feedback') {
    const [resp, end, extra] = handleFeedback(selections, data);
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: end ? 4 : level,
      companyId,
      feature,
      data,
    });
    if (end) {
      if (extra && extra.sms) {
        await sendSMS(phoneNumber, extra.sms);
      }
      await SessionsRepo.del(sessionId);
      return res.send(`END ${resp}`);
    }
    return res.send(`CON ${resp}`);
  }

  await SessionsRepo.upsert({
    sessionId,
    phoneNumber,
    level,
    companyId,
    feature,
    data,
  });
  return res.send('END Unexpected selection. Please try again later.');
}

/**
 * Route registration
 */
app.post('/ussd', handleUssd);

/**
 * Start server
 */
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`TransitLink USSD server listening on port ${PORT}`);
});
