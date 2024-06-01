import ElevenLabs from 'elevenlabs-node';
import {config} from 'dotenv';
import express from 'express';
import http from 'http';
import {RTCIceCandidate, nonstandard, MediaStream, RTCPeerConnection, RTCSessionDescription} from '@roamhq/wrtc';
import {Server} from 'socket.io';
import lamejs from 'lamejs';
import fs from 'fs';
import cors from 'cors';
import {RTCAudioData} from '@roamhq/wrtc/types/nonstandard';
import {OpenAI} from 'openai';
import {makeOpenaiRequest, makeOpenaiRequestRaw} from './openai';
import {z} from 'zod';
import {WaveFile} from 'wavefile';
import {NodeWebRtcAudioStreamSource} from './nodeWebrtcAudioStreamSource';
import {Readable} from 'stream';
import wav from 'wav-decoder';
import wavEncoder from 'wav-encoder';
import axios from 'axios';

config();

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
        sink.ondata = (data: RTCAudioData) => {
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
            console.log('finished');
            onFinish();
          }
          // wait for the audio to finish
        };

        async function onFinish() {
          sink.stop();
          console.log('processing audio');
          console.time('start');
          const mp3buf = mp3Encoder.flush();
          if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
          }
          const blob = new Blob(mp3Data, {type: 'audio/mp3'});
          const buffer = Buffer.from(await blob.arrayBuffer());
          fs.writeFileSync('audio_output.mp3', buffer);
          console.log('wrote audio');
          await timeout(5);
          const openai = new OpenAI(process.env.OPENAI_API_KEY);
          const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream('audio_output.mp3'),
            model: 'whisper-1',
            language: 'en',
            response_format: 'text',
          });
          console.log('transcribed', transcription);

          const response = await makeOpenaiRequestRaw({
            model: 'gpt-4o',
            systemMessage: 'You respond to questions. Be helpful but terse.',
            userMessage: transcription,
            // zSchema: z.object({
            //   response: z.string(),
            // }),
            temperature: 0,
          });
          console.log('response', response);

          const tResponse = await getElevenLabs({
            // Required Parameters
            fileName: 'audio.wav', // The name of your audio file
            textInput: response, // The text you want to convert to speech
            // Optional Parameters
            voiceId: '21m00Tcm4TlvDq8ikWAM', // A different Voice ID from the default
            stability: 0.5, // The stability for the converted speech
            similarityBoost: 0.5, // The similarity boost for the converted speech
            modelId: 'eleven_multilingual_v2', // The ElevenLabs Model ID
            style: 1, // The style exaggeration for the converted speech
            speakerBoost: true, // The speaker boost for the converted speech
          });

          console.log('got response audio', tResponse);

          audioSource.addStream(tResponse, 16, 16000, 1);
          console.timeEnd('start');

          console.log('doneish');
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
async function getElevenLabs({voiceId, textInput, stability, similarityBoost, modelId, style, speakerBoost}: any) {
  const elevenLabsAPIV1 = 'https://api.elevenlabs.io/v1';
  const voiceIdValue = voiceId;
  const voiceURL = `${elevenLabsAPIV1}/text-to-speech/${voiceIdValue}`;
  const stabilityValue = stability ? stability : 0;
  const similarityBoostValue = similarityBoost ? similarityBoost : 0;
  const styleValue = style ? style : 0;

  try {
    const response = await axios({
      method: 'POST',
      url: voiceURL + '?output_format=pcm_16000',
      data: {
        text: textInput,
        voice_settings: {
          stability: stabilityValue,
          similarity_boost: similarityBoostValue,
          style: styleValue,
          use_speaker_boost: speakerBoost,
        },
        model_id: modelId ? modelId : undefined,
      },
      headers: {
        Accept: 'audio/wav',
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      responseType: 'stream',
    });

    return response.data;
  } catch (ex) {
    console.log(ex);
  }
  return null;
}
