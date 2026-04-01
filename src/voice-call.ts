/**
 * Voice Call Server — Twilio + OpenAI Realtime API bridge
 *
 * Flow:
 * 1. Agent writes IPC file with type: "phone_call"
 * 2. IPC handler calls initiateCall()
 * 3. Twilio REST API creates outbound call with webhook URL
 * 4. When callee answers, Twilio hits /voice/connect/:callId (returns TwiML with <Stream>)
 * 5. Twilio opens WebSocket to /media-stream/:callId
 * 6. We bridge audio to/from OpenAI Realtime API
 * 7. On call end, transcript is injected back to the originating group
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import twilio from 'twilio';
import { readEnvFile } from './env.js';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { tryServePublishedPage } from './public-pages.js';

export interface VoiceCallDeps {
  onCallComplete: (
    originGroupFolder: string,
    originGroupJid: string,
    phone: string,
    transcript: TranscriptEntry[],
    duration: number,
    status: string,
  ) => void;
  onRecordingReady?: (
    originGroupFolder: string,
    originGroupJid: string,
    phone: string,
    filePath: string,
  ) => void;
}

export interface TranscriptEntry {
  role: 'ai' | 'human';
  text: string;
}

interface ActiveCall {
  callId: string;
  phone: string;
  instruction: string;
  originGroupFolder: string;
  originGroupJid: string;
  twilioCallSid?: string;
  openaiWs?: WebSocket;
  transcript: TranscriptEntry[];
  startTime: number;
  maxDuration: number;
  streamSid?: string;
  recordingUrl?: string;
}

const activeCalls = new Map<string, ActiveCall>();
const recentCalls = new Map<
  string,
  { originGroupFolder: string; originGroupJid: string; phone: string }
>();

let twilioClient: ReturnType<typeof twilio> | null = null;
let twilioAccountSid = '';
let twilioAuthToken = '';
let twilioPhoneNumber = '';
let openaiApiKey = '';
let publicBaseUrl = '';
let deps: VoiceCallDeps;

export function startVoiceCallServer(
  port: number,
  publicUrl: string,
  callDeps: VoiceCallDeps,
): http.Server {
  const env = readEnvFile([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'OPENAI_API_KEY',
  ]);

  twilioAccountSid = env.TWILIO_ACCOUNT_SID;
  twilioAuthToken = env.TWILIO_AUTH_TOKEN;
  twilioClient =
    twilioAccountSid && twilioAuthToken
      ? twilio(twilioAccountSid, twilioAuthToken)
      : null;
  twilioPhoneNumber = env.TWILIO_PHONE_NUMBER;
  openaiApiKey = env.OPENAI_API_KEY;
  publicBaseUrl = publicUrl;
  deps = callDeps;

  const server = http.createServer(handleHttpRequest);

  // WebSocket server for Twilio Media Streams
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const url = req.url || '';
    const match = url.match(/\/media-stream\/([^/?]+)/);
    if (!match) {
      logger.warn({ url }, 'Unknown WebSocket connection path');
      ws.close();
      return;
    }

    const callId = match[1];
    const call = activeCalls.get(callId);
    if (!call) {
      logger.warn({ callId }, 'WebSocket for unknown call');
      ws.close();
      return;
    }

    logger.info({ callId, phone: call.phone }, 'Twilio media stream connected');
    handleMediaStream(ws, call);
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port, publicUrl }, 'Voice call server started');
  });

  return server;
}

function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const url = req.url || '';

  if (tryServePublishedPage(req, res)) {
    return;
  }

  // Twilio webhook: call connected, return TwiML with Stream
  if (url.startsWith('/voice/connect/')) {
    const callId = url.split('/voice/connect/')[1]?.split('?')[0];
    const call = activeCalls.get(callId || '');

    if (!call) {
      res.writeHead(404);
      res.end('Call not found');
      return;
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${publicBaseUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/media-stream/${callId}" />
  </Connect>
</Response>`;

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
    logger.info({ callId }, 'TwiML served for call');
    return;
  }

  // Twilio status callback
  if (url.startsWith('/voice/status/')) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const callId = url.split('/voice/status/')[1]?.split('?')[0];
      const params = new URLSearchParams(body);
      const status = params.get('CallStatus') || 'unknown';
      logger.info({ callId, status }, 'Call status update');

      if (
        ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(
          status,
        )
      ) {
        const call = activeCalls.get(callId || '');
        if (call) {
          finishCall(callId!, status);
        }
      }

      res.writeHead(200);
      res.end('OK');
    });
    return;
  }

  // Twilio recording callback
  if (url.startsWith('/voice/recording/')) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      const callId = url.split('/voice/recording/')[1]?.split('?')[0];
      const params = new URLSearchParams(body);
      const recordingUrl = params.get('RecordingUrl');
      const recordingSid = params.get('RecordingSid');

      if (recordingUrl && callId) {
        logger.info({ callId, recordingSid }, 'Recording ready');
        // Download recording as MP3
        try {
          const mp3Url = `${recordingUrl}.mp3`;
          const response = await fetch(mp3Url, {
            headers: {
              Authorization:
                'Basic ' +
                Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString(
                  'base64',
                ),
            },
          });
          if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
            // Find the origin group from active or recently finished calls
            const callInfo = recentCalls.get(callId);
            if (callInfo) {
              const recordingDir = path.join(
                GROUPS_DIR,
                callInfo.originGroupFolder,
                'recordings',
              );
              fs.mkdirSync(recordingDir, { recursive: true });
              const filePath = path.join(
                recordingDir,
                `call-${callInfo.phone.replace(/[^0-9]/g, '')}-${Date.now()}.mp3`,
              );
              fs.writeFileSync(filePath, buffer);
              logger.info({ callId, filePath }, 'Recording saved');
              deps.onRecordingReady?.(
                callInfo.originGroupFolder,
                callInfo.originGroupJid,
                callInfo.phone,
                filePath,
              );
            }
          } else {
            logger.error(
              { callId, status: response.status },
              'Failed to download recording',
            );
          }
        } catch (err) {
          logger.error({ callId, err }, 'Error downloading recording');
        }
      }

      res.writeHead(200);
      res.end('OK');
    });
    return;
  }

  // Health check
  if (url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

function handleMediaStream(twilioWs: WebSocket, call: ActiveCall): void {
  // Connect to OpenAI Realtime API
  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5',
    {
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    },
  );

  call.openaiWs = openaiWs;

  openaiWs.on('open', () => {
    logger.info(
      { callId: call.callId, instruction: call.instruction.slice(0, 200) },
      'OpenAI Realtime API connected',
    );

    // Configure session
    openaiWs.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: call.instruction,
          voice: 'alloy',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      }),
    );

    // Make AI speak first - initiate the conversation
    setTimeout(() => {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['text', 'audio'],
            },
          }),
        );
        logger.info({ callId: call.callId }, 'AI prompted to speak first');
      }
    }, 500);
  });

  openaiWs.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());

      switch (event.type) {
        case 'response.audio.delta':
          // Send audio back to Twilio
          if (call.streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(
              JSON.stringify({
                event: 'media',
                streamSid: call.streamSid,
                media: { payload: event.delta },
              }),
            );
          }
          break;

        case 'response.audio_transcript.done':
          // AI finished speaking — save transcript
          if (event.transcript) {
            call.transcript.push({ role: 'ai', text: event.transcript });
            logger.debug(
              { callId: call.callId, text: event.transcript.slice(0, 100) },
              'AI said',
            );
          }
          break;

        case 'conversation.item.input_audio_transcription.completed':
          // Human finished speaking — save transcript
          if (event.transcript) {
            call.transcript.push({ role: 'human', text: event.transcript });
            logger.debug(
              { callId: call.callId, text: event.transcript.slice(0, 100) },
              'Human said',
            );
          }
          break;

        case 'error':
          logger.error(
            { callId: call.callId, error: event.error },
            'OpenAI Realtime error',
          );
          break;
      }
    } catch (err) {
      logger.error(
        { callId: call.callId, err },
        'Error parsing OpenAI message',
      );
    }
  });

  openaiWs.on('close', () => {
    logger.info({ callId: call.callId }, 'OpenAI WebSocket closed');
  });

  openaiWs.on('error', (err) => {
    logger.error({ callId: call.callId, err }, 'OpenAI WebSocket error');
  });

  // Handle Twilio media events
  twilioWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case 'connected':
          logger.info({ callId: call.callId }, 'Twilio stream connected');
          break;

        case 'start':
          call.streamSid = msg.start.streamSid;
          logger.info(
            { callId: call.callId, streamSid: call.streamSid },
            'Twilio stream started',
          );
          break;

        case 'media':
          // Forward audio from Twilio to OpenAI
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: msg.media.payload,
              }),
            );
          }
          break;

        case 'stop':
          logger.info({ callId: call.callId }, 'Twilio stream stopped');
          openaiWs.close();
          break;
      }
    } catch (err) {
      logger.error(
        { callId: call.callId, err },
        'Error parsing Twilio message',
      );
    }
  });

  twilioWs.on('close', () => {
    logger.info({ callId: call.callId }, 'Twilio WebSocket closed');
    openaiWs.close();
  });

  twilioWs.on('error', (err) => {
    logger.error({ callId: call.callId, err }, 'Twilio WebSocket error');
  });

  // Max duration timeout
  setTimeout(() => {
    if (twilioWs.readyState === WebSocket.OPEN) {
      logger.info({ callId: call.callId }, 'Max duration reached, hanging up');
      twilioWs.close();
      openaiWs.close();
    }
  }, call.maxDuration * 1000);
}

function finishCall(callId: string, status: string): void {
  const call = activeCalls.get(callId);
  if (!call) return;

  const duration = Math.round((Date.now() - call.startTime) / 1000);
  logger.info(
    {
      callId,
      phone: call.phone,
      duration,
      status,
      transcriptLength: call.transcript.length,
    },
    'Call finished',
  );

  // Save for recording callback
  recentCalls.set(callId, {
    originGroupFolder: call.originGroupFolder,
    originGroupJid: call.originGroupJid,
    phone: call.phone,
  });
  // Auto-cleanup after 10 minutes
  setTimeout(() => recentCalls.delete(callId), 600000);

  // Clean up
  call.openaiWs?.close();
  activeCalls.delete(callId);

  // Deliver result to agent
  deps.onCallComplete(
    call.originGroupFolder,
    call.originGroupJid,
    call.phone,
    call.transcript,
    duration,
    status,
  );
}

export async function initiateCall(
  callId: string,
  phone: string,
  instruction: string,
  maxDuration: number,
  originGroupFolder: string,
  originGroupJid: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!twilioClient) {
    return { ok: false, error: 'Twilio not configured' };
  }

  const formattedPhone = phone.startsWith('+') ? phone : `+${phone}`;

  const call: ActiveCall = {
    callId,
    phone: formattedPhone,
    instruction,
    originGroupFolder,
    originGroupJid,
    transcript: [],
    startTime: Date.now(),
    maxDuration,
  };

  activeCalls.set(callId, call);

  try {
    const twilioCall = await twilioClient.calls.create({
      to: formattedPhone,
      from: twilioPhoneNumber,
      url: `${publicBaseUrl}/voice/connect/${callId}`,
      statusCallback: `${publicBaseUrl}/voice/status/${callId}`,
      statusCallbackEvent: [
        'completed',
        'busy',
        'no-answer',
        'failed',
        'canceled',
      ],
      statusCallbackMethod: 'POST',
      record: true,
      recordingStatusCallback: `${publicBaseUrl}/voice/recording/${callId}`,
      recordingStatusCallbackEvent: ['completed'],
      recordingStatusCallbackMethod: 'POST',
    });

    call.twilioCallSid = twilioCall.sid;
    logger.info(
      { callId, sid: twilioCall.sid, phone: formattedPhone },
      'Twilio call initiated',
    );

    return { ok: true };
  } catch (err) {
    activeCalls.delete(callId);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { callId, phone: formattedPhone, err },
      'Failed to initiate Twilio call',
    );
    return { ok: false, error: message };
  }
}
