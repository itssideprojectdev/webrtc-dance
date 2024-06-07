import pronouncing from 'pronouncing';
import {config} from 'dotenv';
import express from 'express';
import http from 'http';
import {RTCIceCandidate, nonstandard, MediaStream, RTCPeerConnection, RTCSessionDescription} from '@roamhq/wrtc';
import {Server} from 'socket.io';
import lamejs from 'lamejs';
import fs from 'fs';
import cors from 'cors';
import {RTCAudioData} from '@roamhq/wrtc/types/nonstandard';
import {OpenAI, toFile} from 'openai';
import {makeOpenaiRequest, makeOpenaiRequestRaw} from './openai';
import {z} from 'zod';
import {NodeWebRtcAudioStreamSource} from './nodeWebrtcAudioStreamSource';
import axios from 'axios';
import {Readable} from 'stream';
import WebSocket from 'ws';

config();
const openai = new OpenAI(process.env.OPENAI_API_KEY);

async function main() {
  const app = express();
  app.use(cors());
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  const peerConnections = {};

  io.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('offer', async (description) => {
      const peerConnection = new RTCPeerConnection({
        iceServers: [
          {urls: 'stun:stun.l.google.com:19302'},
          // Add TURN servers here if needed
        ],
      });

      peerConnections[socket.id] = peerConnection;

      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('candidate', event.candidate);
        }
      };
      const audioSource = new NodeWebRtcAudioStreamSource();
      const audioStreamTrack = audioSource.createTrack();
      const mediaStream = new MediaStream([audioStreamTrack]);
      peerConnection.addTrack(audioStreamTrack, mediaStream);

      peerConnection.ontrack = (event) => {
        const audio = event.streams[0];
        const audioTracks = audio.getAudioTracks();
        const audioTrack = audioTracks[0];

        const sink = new nonstandard.RTCAudioSink(audioTrack);

        const mp3Encoder = new lamejs.Mp3Encoder(1, 48000, 128);
        const mp3Data: Buffer[] = [];
        let minimumThreshold = 20;
        let countInLowestSample = 0;
        let startedHearingSound = false;
        let stopSink = false;
        function resetSink() {
          countInLowestSample = 0;
          startedHearingSound = false;
          stopSink = false;
        }
        sink.ondata = (data: RTCAudioData) => {
          if (stopSink) {
            return;
          }
          // todo force record whitenoise initial to set baseline

          const sum = data.samples.reduce((a, b) => a + b, 0);
          const avg = Math.abs(sum / data.samples.length);
          // console.log(Math.round(avg));
          if (avg < minimumThreshold) {
            // minimumThreshold = avg;
          }
          const samples = new Int16Array(data.samples.buffer);
          const mp3buf = mp3Encoder.encodeBuffer(samples);
          if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
          }
          if (!startedHearingSound && avg > minimumThreshold) {
            console.log('heard');
            startedHearingSound = true;
          } else if (startedHearingSound && avg <= minimumThreshold) {
            // console.log('stopped hearing', countInLowestSample);
            countInLowestSample++;
          } else {
            countInLowestSample = 0;
          }
          if (countInLowestSample > 20) {
            onFinish();
          }
          // wait for the audio to finish
        };

        async function onFinish() {
          stopSink = true;
          console.log('processing audio');
          console.time('end to end');
          const mp3buf = mp3Encoder.flush();
          if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
          }
          const blob = new Blob(mp3Data, {type: 'audio/mp3'});
          mp3Data.length = 0;
          const buffer = Buffer.from(await blob.arrayBuffer());

          const stream = {
            current: () => {},
          };
          const readable = new Readable({
            read(size: number) {
              // do nothing
            },
          });
          await getElevenLabsWS(
            {
              // Required Parameters
              // Optional Parameters
              voiceId: 'N2lVS1w4EtoT3dr4eOWO', // A different Voice ID from the default
              // stability: 0.5, // The stability for the converted speech
              // similarityBoost: 0.5, // The similarity boost for the converted speech
              modelId: 'eleven_turbo_v2', // The ElevenLabs Model ID
              // style: 1, // The style exaggeration for the converted speech
              // speakerBoost: true, // The speaker boost for the converted speech
            },
            readable,
            stream,
            () => {
              console.timeEnd('end to end');
            }
          );

          audioSource.addStream(readable, 16, 16000, 1);

          const transcription = await openai.audio.transcriptions.create({
            file: await toFile(buffer, 'audio.mp3'),
            model: 'whisper-1',
            language: 'en',
          });
          console.log('transcribed', transcription);

          await makeOpenaiRequestRaw(
            {
              model: 'gpt-4o',
              systemMessage: 'You respond to questions. Be helpful but terse.',
              userMessage: transcription.text,
              // zSchema: z.object({
              //   response: z.string(),
              // }),
              temperature: 0,
            },
            stream
          );
          resetSink();
        }
      };

      const desc = new RTCSessionDescription(description);
      await peerConnection.setRemoteDescription(desc);

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit('answer', peerConnection.localDescription);
    });

    socket.on('candidate', async (candidate) => {
      const peerConnection = peerConnections[socket.id];
      if (peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socket.on('disconnect', () => {
      const peerConnection = peerConnections[socket.id];
      if (peerConnection) {
        peerConnection.close();
        delete peerConnections[socket.id];
      }
    });
  });

  server.listen(3000, () => console.log('Server is running on port 3000'));
}

main().then(() => {});

function timeout(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function getElevenLabs(
  {voiceId, textInput, stability, similarityBoost, modelId, style, speakerBoost}: any,
  readable: Readable
) {
  const elevenLabsAPIV1 = 'https://api.elevenlabs.io/v1';
  const voiceIdValue = voiceId;
  const voiceURL = `${elevenLabsAPIV1}/text-to-speech/${voiceIdValue}/stream`;
  const stabilityValue = stability ? stability : 0;
  const similarityBoostValue = similarityBoost ? similarityBoost : 0;
  const styleValue = style ? style : 0;

  try {
    const response = await fetch(`${voiceURL}?output_format=pcm_16000&optimize_streaming_latency=2`, {
      method: 'POST',
      headers: {
        Accept: 'audio/wav',
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: textInput,
        voice_settings: {
          stability: stabilityValue,
          similarity_boost: similarityBoostValue,
          style: styleValue,
          use_speaker_boost: speakerBoost,
        },
        model_id: modelId ? modelId : undefined,
      }),
    });
    console.timeEnd('start axios');

    if (response.ok) {
      console.log('ready');
      console.time('stream');
      const reader = response.body!.getReader();

      while (true) {
        const {done, value} = await reader.read();

        if (done) {
          console.timeEnd('stream');
          break;
        }
        readable.push(value);
      }
    }
  } catch (ex) {
    console.log(ex);
  }
  return null;
}

async function getElevenLabsWS(
  {voiceId, stability, similarityBoost, modelId, style, speakerBoost}: any,
  readable: Readable,
  onGetText: {current: (text: string) => void},
  onFirstAudio: () => void
) {
  const ws = new WebSocket(
    `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&output_format=pcm_16000`
  );
  // no array buffer

  const send = (text: string) => {
    if (text === null) {
    }
    if (text === '') return;
    let s = JSON.stringify({
      text: text,
      flush: text === null,
      try_trigger_generation: true,
      xi_api_key: process.env.ELEVENLABS_API_KEY,
      generation_config: {
        chunk_length_schedule: [50, 160, 250, 290],
      },
    });
    ws.send(s);
  };

  let buffer = '';
  let first = false;
  onGetText.current = (text: string) => {
    if (!first) {
      first = true;
    }
    if (ws.readyState === WebSocket.OPEN) {
      if (buffer.length > 0) {
        send(buffer + text);
        buffer = '';
      } else {
        send(text);
      }
    } else {
      buffer += text;
    }
  };

  ws.on('open', function open() {});
  let firstAudio = false;
  ws.on('message', function incoming(data: string) {
    if (!firstAudio) {
      firstAudio = true;
      onFirstAudio();
    }
    let parse = JSON.parse(data.toString()) as Result;
    if (!parse.audio) {
      // console.log(parse);
    } else {
      const base64 = parse.audio;
      const buffer = Buffer.from(base64, 'base64');
      readable.push({
        buffer,
        phones: processPhones(parse),
      });
    }
  });

  return null;
}

type Result = {
  audio: string;
  alignment: {
    chars: string[];
    charStartTimesMs: number[];
  };
};

const phones = [
  'AA',
  'AE',
  'AH',
  'AO',
  'AW',
  'AY',
  'B',
  'CH',
  'D',
  'DH',
  'EH',
  'ER',
  'EY',
  'F',
  'G',
  'HH',
  'IH',
  'IY',
  'JH',
  'K',
  'L',
  'M',
  'N',
  'NG',
  'OW',
  'OY',
  'P',
  'R',
  'S',
  'SH',
  'T',
  'TH',
  'UH',
  'UW',
  'V',
  'W',
  'Y',
  'Z',
  'ZH',
];

const phonesLookup: {
  [key: string]: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'X';
} = {
  AA: 'D',
  AE: 'C',
  AH: 'D',
  AO: 'E',
  AW: 'F',
  AY: 'C',
  B: 'A',
  CH: 'B',
  D: 'B',
  DH: 'B',
  EH: 'C',
  ER: 'E',
  EY: 'C',
  F: 'G',
  G: 'B',
  HH: 'B',
  IH: 'C',
  IY: 'B',
  JH: 'B',
  K: 'B',
  L: 'H',
  M: 'A',
  N: 'B',
  NG: 'B',
  OW: 'F',
  OY: 'F',
  P: 'A',
  R: 'E',
  S: 'B',
  SH: 'B',
  T: 'B',
  TH: 'B',
  UH: 'E',
  UW: 'F',
  V: 'G',
  W: 'F',
  Y: 'F',
  Z: 'B',
  ZH: 'B',
  pause: 'X',
};

export type PhonesResult = {
  time: number;
  duration: number;
  word: string;
  phones: ('A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'X')[];
}[];

function processPhones(result: Result): PhonesResult {
  let words: PhonesResult = [];
  let currentWord = '';
  for (let i = 0; i < result.alignment.chars.length; i++) {
    const char = result.alignment.chars[i];
    if (/[\s,.!?;:()]+/.test(char)) {
      if (currentWord.length > 0) {
        words.push({
          time: result.alignment.charStartTimesMs[i - currentWord.length],
          duration: result.alignment.charStartTimesMs[i] - result.alignment.charStartTimesMs[i - currentWord.length],
          word: currentWord,
          phones: (pronouncing.phonesForWord(currentWord.toLowerCase()) as string[])[0]
            .split(' ')
            .map((e) => phonesLookup[e.replace(/\d/g, '')]),
        });
        currentWord = '';
      }
      continue;
    }
    currentWord += char;
  }
  if (currentWord.length > 0) {
    words.push({
      time: result.alignment.charStartTimesMs[result.alignment.chars.length - currentWord.length],
      duration:
        result.alignment.charStartTimesMs[result.alignment.chars.length] -
        result.alignment.charStartTimesMs[result.alignment.chars.length - currentWord.length],
      word: currentWord,
      phones: (pronouncing.phonesForWord(currentWord.toLowerCase()) as string[])[0]
        .split(' ')
        .map((e) => phones.indexOf(e.replace(/\d/g, ''))),
    });
  }
  return words;
}

const res = {
  alignment: {
    chars: [
      'Y',
      'o',
      'u',
      "'",
      'r',
      'e',
      ' ',
      ' ',
      'w',
      'e',
      'l',
      'c',
      'o',
      'm',
      'e',
      '!',
      ' ',
      'H',
      'o',
      'w',
      ' ',
      'c',
      'a',
      'n',
      ' ',
      'I',
      ' ',
      'a',
      's',
      's',
      'i',
      's',
      't',
      ' ',
      'y',
      'o',
      'u',
      ' ',
      ' ',
      't',
      'o',
      'd',
      'a',
      'y',
      '?',
    ],
    charStartTimesMs: [
      0, 93, 128, 163, 209, 244, 267, 290, 290, 325, 372, 453, 546, 604, 662, 813, 859, 1184, 1265, 1324, 1358, 1405,
      1440, 1486, 1533, 1579, 1625, 1683, 1730, 1788, 1846, 1892, 1950, 1985, 2032, 2067, 2090, 2125, 2183, 2183, 2218,
      2264, 2357, 2415, 2566,
    ],
  },
  audio: '',
};
console.log(processPhones(res));
