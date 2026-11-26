import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import JSZip from 'jszip';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname);
const DATA_DIR = path.resolve(PROJECT_ROOT, '.data');
const STATE_FILE = path.resolve(DATA_DIR, 'nazia-state.json');

const PORT = Number(process.env.PORT || 3000);

interface ReminderItem {
  id: string;
  title: string;
  dueText: string;
  dueTimestamp: number | null;
  completed: boolean;
  createdAt: string;
}

interface MemoryProfile {
  ownerName: string;
  work: string;
  accounts: string;
  inverterSystem: string;
  deviceSetup: string;
  customFacts: string[];
}

interface CustomShortcut {
  id: string;
  keyword: string;
  action: string;
  customPrompt?: string;
  confirmReply?: string;
  createdAt: string;
}

interface NaziaPersistedState {
  memory: MemoryProfile;
  reminders: ReminderItem[];
  notes: string[];
  character: {
    warmth: number;
    loyaltyMode: boolean;
    language: 'roman-urdu' | 'urdu-script' | 'english';
    voicePitch: number;
    voiceRate: number;
  };
  shortcuts: CustomShortcut[];
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function defaultState(): NaziaPersistedState {
  return {
    memory: {
      ownerName: 'Jani',
      work: '',
      accounts: '',
      inverterSystem: '',
      deviceSetup: '',
      customFacts: [],
    },
    reminders: [],
    notes: [],
    character: {
      warmth: 95,
      loyaltyMode: true,
      language: 'roman-urdu',
      voicePitch: 1.12,
      voiceRate: 0.98,
    },
    shortcuts: [],
  };
}

function readState(): NaziaPersistedState {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<NaziaPersistedState>;
    const base = defaultState();
    return {
      memory: { ...base.memory, ...(parsed.memory || {}) },
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      character: { ...base.character, ...(parsed.character || {}) },
      shortcuts: Array.isArray(parsed.shortcuts) ? parsed.shortcuts : [],
    };
  } catch {
    return defaultState();
  }
}

function writeState(state: NaziaPersistedState): void {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function isValidExternalHttpUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getGeminiTtsClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Health check / keep-alive warmer
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, timestamp: Date.now() });
  });

  // Persistent Memory, Reminders & Notes
  app.get('/api/state', (_req, res) => {
    res.json(readState());
  });

  app.put('/api/state', (req, res) => {
    const incoming = req.body as Partial<NaziaPersistedState>;
    const current = readState();
    const updated: NaziaPersistedState = {
      memory: incoming.memory ? { ...current.memory, ...incoming.memory } : current.memory,
      reminders: Array.isArray(incoming.reminders) ? incoming.reminders : current.reminders,
      notes: Array.isArray(incoming.notes) ? incoming.notes : current.notes,
      character: incoming.character
        ? { ...current.character, ...incoming.character }
        : current.character,
      shortcuts: Array.isArray(incoming.shortcuts) ? incoming.shortcuts : current.shortcuts,
    };
    writeState(updated);
    res.json(updated);
  });

  // Real-time Phone <-> Laptop Cross-Device Control Bridge
  interface BridgeClient {
    id: string;
    name: string;
    deviceType: 'phone' | 'laptop' | 'agent';
    res: express.Response;
    connectedAt: string;
  }
  const bridgeClients = new Map<string, BridgeClient>();

  const broadcastDeviceList = () => {
    const list = Array.from(bridgeClients.values()).map((c) => ({
      id: c.id,
      name: c.name,
      deviceType: c.deviceType,
      connectedAt: c.connectedAt,
    }));
    const payload = `event: devices\ndata: ${JSON.stringify(list)}\n\n`;
    for (const client of bridgeClients.values()) {
      client.res.write(payload);
    }
  };

  app.get('/api/bridge/devices', (_req, res) => {
    res.json(
      Array.from(bridgeClients.values()).map((c) => ({
        id: c.id,
        name: c.name,
        deviceType: c.deviceType,
        connectedAt: c.connectedAt,
      }))
    );
  });

  app.get('/api/bridge/stream', (req, res) => {
    const id =
      typeof req.query.deviceId === 'string' && req.query.deviceId.trim()
        ? req.query.deviceId.trim().slice(0, 64)
        : `dev-${Date.now()}`;
    const name =
      typeof req.query.deviceName === 'string' && req.query.deviceName.trim()
        ? req.query.deviceName.trim().slice(0, 60)
        : 'Device';
    const rawType = typeof req.query.deviceType === 'string' ? req.query.deviceType : 'phone';
    const deviceType: 'phone' | 'laptop' | 'agent' =
      rawType === 'laptop' || rawType === 'agent' ? rawType : 'phone';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    bridgeClients.set(id, {
      id,
      name,
      deviceType,
      res,
      connectedAt: new Date().toISOString(),
    });
    broadcastDeviceList();

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      bridgeClients.delete(id);
      broadcastDeviceList();
    });
  });

  app.post('/api/bridge/send', (req, res) => {
    const targetId = typeof req.body?.targetId === 'string' ? req.body.targetId : 'all';
    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    const payload = typeof req.body?.payload === 'string' ? req.body.payload.slice(0, 1000) : '';
    const senderName =
      typeof req.body?.senderName === 'string' ? req.body.senderName.slice(0, 60) : 'Jani';

    const allowedActions = new Set([
      'speak',
      'open_url',
      'clipboard',
      'ring',
      'launch_app',
      'request_screen',
    ]);
    if (!allowedActions.has(action)) {
      res.status(400).json({ error: 'Unsupported bridge command.' });
      return;
    }

    if (action === 'open_url' && !isValidExternalHttpUrl(payload)) {
      res.status(400).json({ error: 'Only safe http/https URLs are allowed.' });
      return;
    }

    const eventData = JSON.stringify({
      action,
      payload,
      senderName,
      timestamp: new Date().toISOString(),
    });
    const sseFrame = `event: command\ndata: ${eventData}\n\n`;

    let delivered = 0;
    for (const [id, client] of bridgeClients.entries()) {
      if (targetId === 'all' || id === targetId) {
        client.res.write(sseFrame);
        delivered += 1;
      }
    }

    res.json({ ok: true, delivered });
  });

  // Free Live Weather Endpoint (Open-Meteo - No API Key Needed)
  app.get('/api/weather', async (req, res) => {
    try {
      const cityRaw = typeof req.query.city === 'string' ? req.query.city.trim() : 'Karachi';
      const city = cityRaw.slice(0, 60) || 'Karachi';
      const geoResp = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
      );
      if (!geoResp.ok) {
        res.status(502).json({ error: 'Weather geocoding service unavailable.' });
        return;
      }
      const geoData = (await geoResp.json()) as {
        results?: Array<{ name: string; country?: string; latitude: number; longitude: number }>;
      };
      const place = geoData.results?.[0];
      if (!place) {
        res.status(404).json({ error: `City "${city}" not found.` });
        return;
      }
      const wxResp = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code&timezone=auto`
      );
      if (!wxResp.ok) {
        res.status(502).json({ error: 'Weather forecast service unavailable.' });
        return;
      }
      const wxData = (await wxResp.json()) as {
        current?: {
          temperature_2m: number;
          relative_humidity_2m: number;
          apparent_temperature: number;
          wind_speed_10m: number;
          weather_code: number;
        };
      };
      const cur = wxData.current;
      if (!cur) {
        res.status(502).json({ error: 'Weather data unavailable.' });
        return;
      }
      res.json({
        city: place.name,
        country: place.country || '',
        tempC: cur.temperature_2m,
        feelsLikeC: cur.apparent_temperature,
        humidity: cur.relative_humidity_2m,
        windKmh: cur.wind_speed_10m,
        weatherCode: cur.weather_code,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Weather check failed.' });
    }
  });

  // Gemini AI Chat / Search / Code & Link Inspector / Screen & Camera Vision
  app.post('/api/chat', async (req, res) => {
    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error: 'GEMINI_API_KEY is not configured in server secrets.',
      });
      return;
    }

    try {
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      const mode = typeof req.body?.mode === 'string' ? req.body.mode : 'chat';
      const imageBase64 =
        typeof req.body?.imageBase64 === 'string' ? req.body.imageBase64 : undefined;
      const imageMimeType =
        typeof req.body?.imageMimeType === 'string' ? req.body.imageMimeType : 'image/jpeg';
      const history = Array.isArray(req.body?.history)
        ? (req.body.history as Array<{ role: string; text: string }>).slice(-10)
        : [];

      if (!prompt && !imageBase64) {
        res.status(400).json({ error: 'Prompt or image is required.' });
        return;
      }

      const state = readState();
      const memLines = [
        `Owner Name: ${state.memory.ownerName || 'Jani'}`,
        state.memory.work ? `Owner Work: ${state.memory.work}` : '',
        state.memory.accounts ? `Owner Accounts: ${state.memory.accounts}` : '',
        state.memory.inverterSystem ? `Inverter/Solar Setup: ${state.memory.inverterSystem}` : '',
        state.memory.deviceSetup ? `System/Device Setup: ${state.memory.deviceSetup}` : '',
        state.memory.customFacts.length > 0
          ? `Remembered Personal Facts: ${state.memory.customFacts.join('; ')}`
          : '',
        state.reminders.filter((r) => !r.completed).length > 0
          ? `Pending Reminders: ${state.reminders
              .filter((r) => !r.completed)
              .map((r) => `${r.title} (${r.dueText})`)
              .join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      const langInstruction =
        state.character.language === 'urdu-script'
          ? 'Reply primarily in natural Pakistani Urdu script (اردو) with clear, warm, affectionate female tone.'
          : state.character.language === 'english'
          ? 'Reply in warm, clear English with affectionate "Jani" greeting.'
          : 'Reply in natural conversational Roman Urdu (like spoken Pakistani Urdu written clearly in Latin script, e.g. "Ji Jani, bilkul...") so voice TTS and reading feel human and natural.';

      const systemInstruction = `You are NAZIA, Jani's deeply loyal, smart, caring personal AI assistant ("wafadar" like Jarvis, with a warm female personality).
Rules:
1. Always address the user affectionately and respectfully as "Jani" (never get angry, never be rude).
2. ${langInstruction}
3. Never ask Jani for personal details he hasn't chosen to share. Use only the known Owner Memory below when relevant.
4. Keep answers practical, accurate, and concise for mobile reading & voice playback (unless Jani asks for a detailed TikTok content plan, online earning roadmap, or code fix).
5. If Jani gives a link/URL, analyze what the page is about and clearly point out any issues, improvements, or summary.
6. If Jani shares a screen capture or camera image, describe what is clearly visible and help him solve it.

Known Owner Memory:
${memLines || 'Owner Name: Jani'}`;

      const urlsInPrompt = (prompt.match(/https?:\/\/[^\s)]+/gi) || []).filter(isValidExternalHttpUrl);

      const tools: Array<Record<string, unknown>> = [];
      if (mode === 'search' || /\b(search|internet|news|mausam|weather|earning|tiktok|rate|price|today|aaj)\b/i.test(prompt)) {
        tools.push({ googleSearch: {} });
      }
      if (urlsInPrompt.length > 0) {
        tools.push({ urlContext: {} });
      }

      const conversationText = history
        .map((h) => `${h.role === 'user' ? 'Jani' : 'Nazia'}: ${h.text}`)
        .join('\n');

      const fullPrompt = conversationText
        ? `Previous context:\n${conversationText}\n\nJani's latest message: ${prompt || 'Please inspect this image.'}`
        : prompt || 'Please inspect this image and explain clearly.';

      const parts: Array<Record<string, unknown>> = [];
      if (imageBase64) {
        const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
        parts.push({
          inlineData: {
            mimeType: imageMimeType,
            data: cleanBase64,
          },
        });
      }
      parts.push({ text: fullPrompt });

      let response;
      try {
        response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: { parts },
          config: {
            systemInstruction,
            ...(tools.length > 0 ? { tools } : {}),
          },
        });
      } catch (firstErr) {
        // Retry once cleanly without tools if search/urlContext or socket hiccuped
        console.warn('Gemini primary attempt failed, retrying without tools:', firstErr);
        response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: { parts },
          config: {
            systemInstruction,
          },
        });
      }

      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const sources = chunks
        .map((c: { web?: { uri?: string; title?: string } }) =>
          c.web?.uri ? { uri: c.web.uri, title: c.web.title || c.web.uri } : null
        )
        .filter(Boolean);

      res.json({
        reply: response.text || 'Ji Jani, main sun rahi hoon — zara dobara farmayein.',
        sources,
      });
    } catch (err) {
      console.error('Gemini API error:', err);
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Gemini request failed.',
      });
    }
  });

  // High-quality Urdu Female AI Voice TTS (Gemini 3.8 Flash Lite TTS -> WAV)
  app.post('/api/tts', async (req, res) => {
    const ai = getGeminiTtsClient();
    if (!ai) {
      res.status(503).json({ error: 'GEMINI_API_KEY not configured.' });
      return;
    }

    try {
      const rawText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      if (!rawText) {
        res.status(400).json({ error: 'Text is required.' });
        return;
      }

      const cleanText = rawText
        .replace(/[*_`#]/g, '')
        .replace(/https?:\/\/\S+/g, 'link')
        .slice(0, 700);

      let response;
      try {
        response = await ai.models.generateContent({
          model: 'gemini-3.8-flash-lite-tts',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: cleanText,
                  speechMetadata: {
                    style:
                      'Warm, affectionate, friendly Pakistani female assistant speaking Urdu and Roman Urdu naturally',
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Kore' },
              },
            },
          },
        });
      } catch {
        response = await ai.models.generateContent({
          model: 'gemini-3.8-flash-lite-tts',
          contents: [
            {
              role: 'user',
              parts: [{ text: `Say warmly in a friendly female Urdu voice: ${cleanText}` }],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Kore' },
              },
            },
          },
        });
      }

      const part = response.candidates?.[0]?.content?.parts?.[0];
      const base64Audio = part?.inlineData?.data;
      const mimeType = part?.inlineData?.mimeType || 'audio/wav';

      if (!base64Audio) {
        res.status(502).json({ error: 'TTS audio unavailable.' });
        return;
      }

      res.json({ audioBase64: base64Audio, mimeType });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'TTS generation failed.';
      const isQuota = /429|RESOURCE_EXHAUSTED|quota/i.test(msg);
      console.warn('Gemini TTS fallback to browser voice:', msg);
      res.status(isQuota ? 429 : 502).json({
        error: isQuota ? 'Gemini HD voice daily quota reached — using device voice.' : msg,
        quotaExceeded: isQuota,
      });
    }
  });

  // Universal Voice Transcription Fallback / Trainer Recording (Gemini 3.5 Transcribe -> Gemini 4 Hydrogen)
  app.post('/api/transcribe', async (req, res) => {
    const aiBeta = getGeminiTtsClient();
    const aiDefault = getGeminiClient();
    if (!aiBeta || !aiDefault) {
      res.status(503).json({ error: 'GEMINI_API_KEY not configured.' });
      return;
    }

    try {
      const rawAudio = typeof req.body?.audioBase64 === 'string' ? req.body.audioBase64 : '';
      const rawMime = typeof req.body?.mimeType === 'string' ? req.body.mimeType : 'audio/webm';
      if (!rawAudio) {
        res.status(400).json({ error: 'Audio recording is required.' });
        return;
      }

      const cleanBase64 = rawAudio.includes(',') ? rawAudio.split(',')[1] : rawAudio;
      const baseMime = rawMime.split(';')[0].trim().toLowerCase();
      const allowedMimes = new Set([
        'audio/webm',
        'audio/mp4',
        'audio/mpeg',
        'audio/mp3',
        'audio/ogg',
        'audio/wav',
        'audio/aac',
      ]);
      const safeMime = allowedMimes.has(baseMime) ? baseMime : 'audio/webm';

      const audioPart = {
        inlineData: {
          mimeType: safeMime,
          data: cleanBase64,
        },
      };
      const promptPart = {
        text: 'Transcribe ONLY the exact words spoken in this audio in Roman Urdu or English (no commentary, no quotes, no explanation). If silent or unclear, reply with an empty string.',
      };

      let response;
      try {
        response = await aiBeta.models.generateContent({
          model: 'gemini-3.5-transcribe',
          contents: { parts: [audioPart, promptPart] },
        });
      } catch (primaryErr) {
        console.warn('gemini-3.5-transcribe unavailable, falling back to gemini-4-hydrogen:', primaryErr);
        response = await aiDefault.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: { parts: [audioPart, promptPart] },
        });
      }

      const text = (response.text || '').trim().replace(/^["']|["']$/g, '');
      res.json({ text });
    } catch (err) {
      console.warn('Gemini transcribe error:', err);
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Audio transcription failed.',
      });
    }
  });

  // Complete Source ZIP Export for Phone / Laptop / CodeAssist
  app.get('/api/export-zip', async (_req, res) => {
    try {
      const zip = new JSZip();
      const allowedFiles = [
        'package.json',
        'index.html',
        'tsconfig.json',
        'vite.config.ts',
        'metadata.json',
        '.env.example',
        '.gitignore',
        'server.ts',
      ];
      const allowedDirs = ['src', 'public'];

      for (const file of allowedFiles) {
        const resolved = path.resolve(PROJECT_ROOT, file);
        if (resolved.startsWith(PROJECT_ROOT + path.sep) && fs.existsSync(resolved)) {
          zip.file(file, fs.readFileSync(resolved));
        }
      }

      const addDirRecursive = (dirRel: string) => {
        const dirAbs = path.resolve(PROJECT_ROOT, dirRel);
        if (!dirAbs.startsWith(PROJECT_ROOT + path.sep) || !fs.existsSync(dirAbs)) return;
        const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
        for (const entry of entries) {
          const nextRel = path.join(dirRel, entry.name);
          const nextAbs = path.resolve(PROJECT_ROOT, nextRel);
          if (!nextAbs.startsWith(PROJECT_ROOT + path.sep)) continue;
          if (entry.isDirectory()) {
            addDirRecursive(nextRel);
          } else {
            zip.file(nextRel.replace(/\\/g, '/'), fs.readFileSync(nextAbs));
          }
        }
      };

      for (const dir of allowedDirs) {
        addDirRecursive(dir);
      }

      const appUrl =
        process.env.APP_URL?.trim() ||
        'https://ais-pre-3xy4krzsjzzrcekhtwz4uj-461480328344.asia-east1.run.app';

      // Ready-to-compile Android APK Wrapper (for Android Studio / CodeAssist / GitHub Actions)
      zip.file(
        'android-apk/settings.gradle.kts',
        `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "NaziaAI"
include(":app")
`
      );

      zip.file(
        'android-apk/build.gradle.kts',
        `plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
`
      );

      zip.file(
        'android-apk/gradle.properties',
        `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
`
      );

      zip.file(
        'android-apk/app/build.gradle.kts',
        `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.jani.naziaai"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.jani.naziaai"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
`
      );

      zip.file(
        'android-apk/app/src/main/AndroidManifest.xml',
        `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/Theme.AppCompat.NoActionBar"
        android:usesCleartextTraffic="true">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`
      );

      zip.file(
        'android-apk/app/src/main/res/values/strings.xml',
        `<resources>
    <string name="app_name">Nazia AI</string>
</resources>
`
      );

      const iconPath = path.resolve(PROJECT_ROOT, 'public/assets/pwa-192x192.png');
      if (fs.existsSync(iconPath)) {
        zip.file(
          'android-apk/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
          fs.readFileSync(iconPath)
        );
      }

      zip.file(
        'android-apk/app/src/main/java/com/jani/naziaai/MainActivity.kt',
        `package com.jani.naziaai

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private val appUrl = "${appUrl}"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestAppPermissions()

        webView = WebView(this)
        setContentView(webView)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.allowFileAccess = true

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString() ?: return false
                if (!url.startsWith(appUrl)) {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    return true
                }
                return false
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                runOnUiThread {
                    request?.grant(request.resources)
                }
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                callback?.invoke(origin, true, false)
            }
        }

        webView.loadUrl(appUrl)
    }

    private fun requestAppPermissions() {
        val needed = arrayOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA,
            Manifest.permission.ACCESS_FINE_LOCATION
        ).filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), 101)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
`
      );

      // GitHub Actions Cloud APK Builder (Builds real NaziaAI.apk automatically on GitHub!)
      zip.file(
        '.github/workflows/build-apk.yml',
        `name: Build Nazia AI Android APK
on:
  push:
    branches: [ main ]
  workflow_dispatch:

jobs:
  build-apk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'
      - uses: gradle/actions/setup-gradle@v3
        with:
          gradle-version: '8.7'
      - name: Build Debug APK
        working-directory: android-apk
        run: gradle assembleDebug
      - name: Upload NaziaAI APK
        uses: actions/upload-artifact@v4
        with:
          name: NaziaAI-APK
          path: android-apk/app/build/outputs/apk/debug/*.apk
`
      );

      // Safe Laptop Control Companion Agent (Run on Jani's Windows/Mac/Linux Laptop)
      zip.file(
        'laptop-agent/nazia-laptop-agent.mjs',
        `// Nazia AI Laptop Companion Agent
// Run on your laptop: node nazia-laptop-agent.mjs
import { execFile } from 'node:child_process';
import os from 'node:os';

const SERVER_URL = process.env.NAZIA_SERVER_URL || '${appUrl}';
const DEVICE_ID = 'laptop-agent-' + os.hostname();
const DEVICE_NAME = 'Laptop Agent (' + os.hostname() + ')';

const SAFE_APPS = {
  chrome: process.platform === 'win32' ? ['cmd', ['/c', 'start', 'chrome']] : process.platform === 'darwin' ? ['open', ['-a', 'Google Chrome']] : ['google-chrome', []],
  explorer: process.platform === 'win32' ? ['explorer.exe', []] : process.platform === 'darwin' ? ['open', ['.']] : ['xdg-open', ['.']],
  notepad: process.platform === 'win32' ? ['notepad.exe', []] : process.platform === 'darwin' ? ['open', ['-a', 'TextEdit']] : ['gedit', []],
  calculator: process.platform === 'win32' ? ['calc.exe', []] : process.platform === 'darwin' ? ['open', ['-a', 'Calculator']] : ['gnome-calculator', []],
};

function openSafeUrl(url) {
  if (!/^https?:\\/\\//i.test(url)) return;
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

async function connect() {
  const streamUrl = \`\${SERVER_URL}/api/bridge/stream?deviceId=\${encodeURIComponent(DEVICE_ID)}&deviceName=\${encodeURIComponent(DEVICE_NAME)}&deviceType=agent\`;
  console.log('Nazia Laptop Agent connecting to:', SERVER_URL);
  const resp = await fetch(streamUrl);
  if (!resp.ok || !resp.body) throw new Error('Bridge connect failed: ' + resp.status);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const raw = line.slice(5).trim();
        if (eventName === 'command') {
          try {
            const cmd = JSON.parse(raw);
            console.log('Command from Jani:', cmd);
            if (cmd.action === 'open_url') openSafeUrl(cmd.payload);
            if (cmd.action === 'launch_app' && SAFE_APPS[cmd.payload]) {
              const [bin, args] = SAFE_APPS[cmd.payload];
              execFile(bin, args, () => {});
            }
          } catch {}
        }
        eventName = 'message';
      }
    }
  }
}

connect().catch((err) => {
  console.error(err);
  setTimeout(connect, 4000);
});
`
      );

      const installGuide = `# Nazia AI — Android APK, Laptop Agent & Install Guide

## 1. Fastest Way on Phone (10 Seconds — No PC Needed)
1. Open this link in **Google Chrome** on your Android phone:
   ${appUrl}
2. Tap the **3 dots (⋮)** in Chrome -> tap **"Install app"** or **"Add to Home screen"**.
3. **Nazia AI** will install on your home screen with its icon and open full-screen like a native APK!

## 2. Create a Real .apk File in 1 Minute (PWABuilder)
1. Open https://www.pwabuilder.com on your phone or laptop.
2. Paste your Nazia AI URL:
   ${appUrl}
3. Click **Start -> Package for Stores -> Android -> Generate Package** and download the **.apk**!

## 3. Control Your Laptop Directly From Your Phone
1. Ensure Node.js v20+ is installed on your laptop.
2. Run:
   \`\`\`bash
   node laptop-agent/nazia-laptop-agent.mjs
   \`\`\`
3. Open **Nazia AI -> Screen & Control** on your phone — your Laptop will appear online so you can open YouTube, Chrome, Explorer, Calculator, Notepad, and links on your laptop remotely!

## 4. Build APK Automatically Using GitHub (Free Cloud Build)
This ZIP includes the complete \`android-apk/\` Kotlin project AND \`.github/workflows/build-apk.yml\`.
1. Push this folder to a GitHub repository and open the **Actions** tab -> download **NaziaAI-APK**.
`;

      zip.file('README_INSTALL.md', installGuide);

      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="nazia-ai-source.zip"');
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'ZIP export failed.' });
    }
  });

  // Vite dev middleware vs static production serve
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(PROJECT_ROOT, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Nazia AI server running on http://0.0.0.0:${PORT}`);
  });
  httpServer.keepAliveTimeout = 65000;
  httpServer.headersTimeout = 66000;
}

startServer();
