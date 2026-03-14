import https from 'https';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

/**
 * Transcribe audio using OpenAI Whisper API.
 * Returns the transcript text, or null on failure.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = 'voice.ogg',
): Promise<string | null> {
  const envVars = readEnvFile(['OPENAI_API_KEY']);
  const apiKey = process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY || '';
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set, skipping transcription');
    return null;
  }

  try {
    const boundary = `----FormBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    // file field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    parts.push(audioBuffer);
    parts.push(Buffer.from('\r\n'));

    // model field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`,
      ),
    );

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const result = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.openai.com',
          path: '/v1/audio/transcriptions',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            if (res.statusCode !== 200) {
              reject(new Error(`Whisper API ${res.statusCode}: ${raw}`));
              return;
            }
            try {
              const json = JSON.parse(raw);
              resolve(json.text || '');
            } catch {
              reject(new Error(`Invalid Whisper response: ${raw}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    logger.info({ chars: result.length }, 'Transcribed voice message');
    return result;
  } catch (err) {
    logger.error({ err }, 'OpenAI transcription failed');
    return null;
  }
}
