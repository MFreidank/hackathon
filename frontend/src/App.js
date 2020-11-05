import React, { useState, useEffect } from 'react';
import './assests/css/App.css';
import Amplify from 'aws-amplify';
import awsconfig from './aws-exports';
import AWS from 'aws-sdk';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import recording from './assests/images/record.gif';
import useKeyPress from './hooks/useKeyPress.js';
import moment from 'moment';
import io from 'socket.io-client';
import hark from 'hark';
import { Sparklines, SparklinesLine } from 'react-sparklines';


const crypto            = require('crypto'); // tot sign our pre-signed URL
const audioUtils        = require('./assests/libs/audioUtils');  // for encoding audio data as PCM
const v4                = require('./assests/libs/aws-signature-v4'); // to generate our pre-signed URL
const marshaller        = require("@aws-sdk/eventstream-marshaller"); // for converting binary event stream messages to and from JSON
const util_utf8_node    = require("@aws-sdk/util-utf8-node"); // utilities for encoding and decoding UTF8
const mic               = require('microphone-stream'); // collect microphone input as a stream of raw bytes

// our converter between binary event streams messages and JSON

const THREE = window.THREE
const HOST = window.HOST
const SENDVIDEO = true;
const SENDAUDIO = true;

window.AWS.config.region = 'eu-west-1';
window.AWS.config.credentials = new AWS.CognitoIdentityCredentials({
  IdentityPoolId: 'eu-west-1:292b851e-196b-4148-b7fd-ad6c711be793',
});

class Streamer {

  inputSampleRate;
  transcription = "";
  socket;
  micStream;
  socketError = false;
  transcribeException = false;
  eventStreamMarshaller = new marshaller.EventStreamMarshaller(util_utf8_node.toUtf8, util_utf8_node.fromUtf8);
  capturedText = [];
  videoSocket;
  captureInterval;
  capture;
  imageCapture;
  isSpeaking = false;
  sentiments = []

  constructor() {
    // our global variables for managing state
    this.languageCode = "en-US";
    this.sampleRate = "44100";

    this.comprehend = new AWS.Comprehend();


  }

  startStreaming(options){

    this.setSentimentScore=options.setSentimentScore ? options.setSentimentScore : null;
    this.sentimentScore=options.sentimentScore ? options.sentimentScore : 0;
    this.setSentimentScores= options.setSentimentScores ? options.setSentimentScores : null;
    this.speakingCallback = options.speakingCallback ? options.speakingCallback : null;
    this.emotionCallback = options.emotionCallback ? options.emotionCallback : null;

    // first we get the microphone input from the browser (as a promise)...
    window.navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        })
        // ...then we convert the mic stream to binary event stream messages when the promise resolves
        .then((userMediaStream)=>{this.streamAudioToWebSocket(userMediaStream)})
        .catch(function (error) {
          console.error(error, 'There was an error streaming your audio and video. Please try again.')
        });
  }

  streamAudioToWebSocket(userMediaStream) {
      //let's get the mic input from the browser, via the microphone-stream module

      const self = this;

      // Capturing of Audio

      self.micStream = new mic();


      self.micStream.on("format", function(data) {
          self.inputSampleRate = data.sampleRate;
      });

      self.micStream.setStream(userMediaStream);

      var speechEvents = hark(userMediaStream, {});

      speechEvents.on('speaking', function() {
        console.log('speaking');
        self.isSpeaking = true;
        self.speakingCallback(self.isSpeaking)
      });

      speechEvents.on('stopped_speaking', function() {
        console.log('stopped_speaking');
        self.isSpeaking = false;
        self.speakingCallback(self.isSpeaking)
      });


      // Pre-signed URLs are a way to authenticate a request (or WebSocket connection, in this case)
      // via Query Parameters. Learn more: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
      let url = self.createPresignedUrl();

      //open up our WebSocket connection
      self.socket = new WebSocket(url);
      self.socket.binaryType = "arraybuffer";

      let sampleRate = 0;

      // when we get audio data from the mic, send it to the WebSocket if possible
      self.socket.onopen = function() {
          self.micStream.on('data', function(rawAudioChunk) {
              // the audio stream is raw audio bytes. Transcribe expects PCM with additional metadata, encoded as binary
              let binary = self.convertAudioToBinaryMessage(rawAudioChunk);

              if (self.socket.readyState === self.socket.OPEN)
                  self.socket.send(binary);
          }
      )};

      // handle messages, errors, and close events
      self.wireAudioSocketEvents();

      // Capturing of Video
      self.capture = new ImageCapture(userMediaStream.getVideoTracks()[0]);

      console.log("Video Stream is", self.capture.track.readyState)

      self.videoSocket = io('ws://ec2-34-251-228-120.eu-west-1.compute.amazonaws.com:8080')

      const useFrameRate = 1;
      const imageOptions = {imageWidth: 640, imageHeight: 480};
      self.videoSocket.on('connect', () => {
        setTimeout(function(){
          const send = () => self.capture.takePhoto(imageOptions)
          .then(blob => {
            if(SENDVIDEO) self.videoSocket.send(blob);
          })
          .catch((err) => {
            clearInterval(self.captureInterval);
            if(self.capture.track.enabled){
              self.capture.track.stop()
            }
            console.error("Capturing Video Error", err);
          });
          self.captureInterval = setInterval(send ,3000/useFrameRate);
         }, 6000);
      });

      // handle messages, errors, and close events
      self.wireVideoSocketEvents();

  }

  wireAudioSocketEvents() {
      // handle inbound messages from Amazon Transcribe

      const self = this;

      self.socket.onmessage = function (message) {
          //convert the binary event stream message to JSON
          let messageWrapper = self.eventStreamMarshaller.unmarshall(Buffer(message.data));
          let messageBody = JSON.parse(String.fromCharCode.apply(String, messageWrapper.body));
          if (messageWrapper.headers[":message-type"].value === "event") {
              self.handleEventStreamMessage(messageBody);
          }
          else {
              self.transcribeException = true;
              console.error(messageBody.Message);
          }
      };

      self.socket.onerror = function () {
          self.socketError = true;
          console.error('WebSocket connection error. Try again.');
      };

      self.socket.onclose = function (closeEvent) {
          self.micStream.stop();

          // the close event immediately follows the error event; only handle one.
          if (!self.socketError && !self.transcribeException) {
              if (closeEvent.code != 1000) {
                  console.error('Streaming Exception ' + closeEvent.reason);
              }
          }
      };
  }

  wireVideoSocketEvents() {
      // handle inbound messages from Amazon Transcribe

      const self = this;

      self.videoSocket.on('image_path', function (msg) {
          console.log('image_path_received', msg);
      })

      self.videoSocket.on('detected_emotion', function (msg) {
          console.log('detected_emotion', msg);
          if(msg == "neutral"){
            self.emotionCallback(" 😐")
          } else if(msg == "happiness"){
            self.emotionCallback(" 🙂")
          } else if(msg == "surprise"){
            self.emotionCallback(" 😮")
          } else if(msg == "sadness"){
            self.emotionCallback(" 🙁")
          } else if(msg == "anger"){
            self.emotionCallback(" 😤")
          } else if(msg == "disgust"){
            self.emotionCallback(" 🤮")
          } else if(msg == "fear"){
            self.emotionCallback(" 😨")
          }
      })

      self.videoSocket.on('disconnect', () => {
        clearInterval(self.captureInterval);
      });

      self.videoSocket.on('error', function (msg) {
        console.error('videoSocket connection error. Try again.');
        clearInterval(self.captureInterval);
      })

  }


  async handleDetectSentiment(sentence){

    const params = {
        LanguageCode: 'en', /* required */
        Text: sentence /* required */
    };

    try {
       const result = await this.comprehend.detectSentiment(params).promise()
       return result;
    }
    catch(err){
      Promise.reject(new Error(err));
    }
  }

  handleEventStreamMessage(messageJson) {

      const self = this;
      let results = messageJson.Transcript.Results;

      if (results.length > 0) {
          if (results[0].Alternatives.length > 0) {
              let transcript = results[0].Alternatives[0].Transcript;

              // fix encoding for accented characters
              this.transcript = decodeURIComponent(escape(transcript));

              console.log(transcript + "\n");

              // if this transcript segment is final, add it to the overall transcription
              if (!results[0].IsPartial) {
                  //scroll the textarea down
                  this.transcription += transcript + "\n";
                  this.handleDetectSentiment(this.transcript).then((data)=>{
                    let newScore;
                    const {Sentiment} = data;
                    if(Sentiment === "MIXED" || Sentiment === "NEUTRAL") {
                      newScore = 0.5;
                    } else if(Sentiment === "POSITIVE") {
                      newScore = 1;
                    } else if(Sentiment === "NEGATIVE") {
                      newScore = 0;
                    }

                    self.setSentimentScores(newScore);
                  })
              }
          }
      }
  }

  closeSocket() {
      if (this.socket.readyState === this.socket.OPEN) {
          this.micStream.stop();

          // Send an empty frame so that Transcribe initiates a closure of the WebSocket after submitting all transcripts
          let emptyMessage = this.getAudioEventMessage(Buffer.from(new Buffer([])));
          let emptyBuffer = this.eventStreamMarshaller.marshall(emptyMessage);
          this.socket.send(emptyBuffer);
      }
  }

  closeVideoSocket() {
      this.videoSocket.disconnect()
      clearInterval(this.captureInterval);

      if(this.capture.track.enabled){
        this.capture.track.stop()
      }
  }

  convertAudioToBinaryMessage(audioChunk) {
      let raw = mic.toRaw(audioChunk);

      if (raw == null)
          return;

      // downsample and convert the raw audio bytes to PCM
      let downsampledBuffer = audioUtils.downsampleBuffer(raw, this.inputSampleRate, this.sampleRate);
      let pcmEncodedBuffer = audioUtils.pcmEncode(downsampledBuffer);

      // add the right JSON headers and structure to the message
      let audioEventMessage = this.getAudioEventMessage(Buffer.from(pcmEncodedBuffer));

      //convert the JSON object + headers into a binary event stream message
      let binary = this.eventStreamMarshaller.marshall(audioEventMessage);

      return binary;
  }

  getAudioEventMessage(buffer) {
      // wrap the audio data in a JSON envelope
      return {
          headers: {
              ':message-type': {
                  type: 'string',
                  value: 'event'
              },
              ':event-type': {
                  type: 'string',
                  value: 'AudioEvent'
              }
          },
          body: buffer
      };
  }

  createPresignedUrl() {

      const self = this;

      const {AccessKeyId, SecretKey, SessionToken} = window.AWS.config.credentials.data.Credentials;


      let endpoint = "transcribestreaming." +  window.AWS.config.region + ".amazonaws.com:8443";

      // get a preauthenticated URL that we can use to establish our WebSocket
      return v4.createPresignedURL(
          'GET',
          endpoint,
          '/stream-transcription-websocket',
          'transcribe',
          crypto.createHash('sha256').update('', 'utf8').digest('hex'), {
              'key': AccessKeyId,
              'secret': SecretKey,
              'sessionToken': SessionToken,
              'protocol': 'wss',
              'expires': 15,
              'region':  window.AWS.config.region,
              'query': "language-code=" + self.languageCode + "&media-encoding=pcm&sample-rate=" + self.sampleRate
          }
      );
  }

}



//// Setup 3D Character

// Set up base scene
function createScene() {
  // Base scene
  const scene = new THREE.Scene();
  const clock = new THREE.Clock();
  scene.background = new THREE.Color("rgb(0, 142, 174)");
  scene.fog = new THREE.Fog(0x33334d, 4, 10);

  // Renderer
  const renderer = new THREE.WebGLRenderer({antialias: true});
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.setClearColor(0x33334d);
  renderer.domElement.id = 'renderCanvas';
  document.getElementById('container').appendChild(renderer.domElement)

  // Env map
  new THREE.TextureLoader()
    .load('assets/images/machine_shop.jpg', hdrEquirect => {

      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      pmremGenerator.compileEquirectangularShader();

      const hdrCubeRenderTarget = pmremGenerator.fromEquirectangular(
        hdrEquirect
      );
      hdrEquirect.dispose();
      pmremGenerator.dispose();

      scene.environment = hdrCubeRenderTarget.texture;

    });


  // Camera
  const camera = new THREE.PerspectiveCamera(
    THREE.MathUtils.radToDeg(0.8),
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  const controls = new OrbitControls(camera, renderer.domElement);
  camera.position.set(0, 1.4, 3.1);
  controls.target = new THREE.Vector3(0, 0.8, 0);
  controls.screenSpacePanning = true;
  controls.update();

  // Handle window resize
  function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onWindowResize, false);

  // Render loop
  function render() {
    requestAnimationFrame(render);
    controls.update();

    renderFn.forEach(fn => {
      fn();
    });

    renderer.render(scene, camera);
  }

  render();

  // Lights
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x000000, 0.6);
  hemiLight.position.set(0, 200, 0);
  hemiLight.intensity = 0.6;
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff);
  dirLight.position.set(0, 5, 5);

  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  dirLight.shadow.camera.top = 2.5;
  dirLight.shadow.camera.bottom = -2.5;
  dirLight.shadow.camera.left = -2.5;
  dirLight.shadow.camera.right = 2.5;
  dirLight.shadow.camera.near = 0.1;
  dirLight.shadow.camera.far = 40;
  scene.add(dirLight);

  const dirLightTarget = new THREE.Object3D();
  dirLight.add(dirLightTarget);
  dirLightTarget.position.set(0, -0.5, -1.0);
  dirLight.target = dirLightTarget;

  // Environment
  const groundMat = new THREE.MeshStandardMaterial({
    color: "rgb(0, 142, 174)",
    depthWrite: false,
  });
  groundMat.metalness = 0;
  groundMat.refractionRatio = 0;
  const ground = new THREE.Mesh(
    new THREE.PlaneBufferGeometry(100, 100),
    groundMat
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  return {scene, camera, clock};
}

// Load character model and animations
async function loadCharacter(
  scene,
  characterFile,
  animationPath,
  animationFiles
) {
  // Asset loader
  const fileLoader = new THREE.FileLoader();
  const gltfLoader = new GLTFLoader();

  function loadAsset(loader, assetPath, onLoad) {
    return new Promise(resolve => {
      loader.load(assetPath, async asset => {
        if (onLoad[Symbol.toStringTag] === 'AsyncFunction') {
          const result = await onLoad(asset);
          resolve(result);
        } else {
          resolve(onLoad(asset));
        }
      });
    });
  }

  // Load character model
  const {character, bindPoseOffset} = await loadAsset(
    gltfLoader,
    characterFile,
    gltf => {
      // Transform the character
      const character = gltf.scene;
      scene.add(character);

      // Make the offset pose additive
      const [bindPoseOffset] = gltf.animations;
      if (bindPoseOffset) {
        THREE.AnimationUtils.makeClipAdditive(bindPoseOffset);
      }

      // Cast shadows
      character.traverse(object => {
        if (object.isMesh) {
          object.castShadow = true;
        }
      });

      return {character, bindPoseOffset};
    }
  );

  // Load animations
  const clips = await Promise.all(
    animationFiles.map((filename, index) => {
      const filePath = `${animationPath}/${filename}`;

      return loadAsset(gltfLoader, filePath, async gltf => {
        return gltf.animations;
      });
    })
  );

  return {character, clips, bindPoseOffset};
}

// Initialize the host
function createHost(
  character,
  audioAttachJoint,
  voice,
  engine,
  idleClip,
  faceIdleClip,
  lipsyncClips,
  gestureClips,
  gestureConfig,
  emoteClips,
  blinkClips,
  poiClips,
  poiConfig,
  lookJoint,
  bindPoseOffset,
  clock,
  camera,
  scene
) {
  // Add the host to the render loop
  const host = new HOST.HostObject({owner: character, clock});
  renderFn.push(() => {
    host.update();
  });

  // Set up text to speech
  const audioListener = new THREE.AudioListener();
  camera.add(audioListener);
  host.addFeature(HOST.aws.TextToSpeechFeature, false, {
    listener: audioListener,
    attachTo: audioAttachJoint,
    voice,
    engine,
  });

  // Set up animation
  host.addFeature(HOST.anim.AnimationFeature);

  // Base idle
  host.AnimationFeature.addLayer('Base');
  host.AnimationFeature.addAnimation(
    'Base',
    idleClip.name,
    HOST.anim.AnimationTypes.single,
    {clip: idleClip}
  );
  host.AnimationFeature.playAnimation('Base', idleClip.name);

  // Face idle
  host.AnimationFeature.addLayer('Face', {
    blendMode: HOST.anim.LayerBlendModes.Additive,
  });
  THREE.AnimationUtils.makeClipAdditive(faceIdleClip);
  host.AnimationFeature.addAnimation(
    'Face',
    faceIdleClip.name,
    HOST.anim.AnimationTypes.single,
    {
      clip: THREE.AnimationUtils.subclip(
        faceIdleClip,
        faceIdleClip.name,
        1,
        faceIdleClip.duration * 30,
        30
      ),
    }
  );
  host.AnimationFeature.playAnimation('Face', faceIdleClip.name);

  // Blink
  host.AnimationFeature.addLayer('Blink', {
    blendMode: HOST.anim.LayerBlendModes.Additive,
    transitionTime: 0.075,
  });
  blinkClips.forEach(clip => {
    THREE.AnimationUtils.makeClipAdditive(clip);
  });
  host.AnimationFeature.addAnimation(
    'Blink',
    'blink',
    HOST.anim.AnimationTypes.randomAnimation,
    {
      playInterval: 3,
      subStateOptions: blinkClips.map(clip => {
        return {
          name: clip.name,
          loopCount: 1,
          clip,
        };
      }),
    }
  );
  host.AnimationFeature.playAnimation('Blink', 'blink');

  // Talking idle
  host.AnimationFeature.addLayer('Talk', {
    transitionTime: 0.75,
    blendMode: HOST.anim.LayerBlendModes.Additive,
  });
  host.AnimationFeature.setLayerWeight('Talk', 0);
  const talkClip = lipsyncClips.find(c => c.name === 'stand_talk');
  lipsyncClips.splice(lipsyncClips.indexOf(talkClip), 1);
  host.AnimationFeature.addAnimation(
    'Talk',
    talkClip.name,
    HOST.anim.AnimationTypes.single,
    {clip: THREE.AnimationUtils.makeClipAdditive(talkClip)}
  );
  host.AnimationFeature.playAnimation('Talk', talkClip.name);

  // Gesture animations
  host.AnimationFeature.addLayer('Gesture', {
    transitionTime: 0.5,
    blendMode: HOST.anim.LayerBlendModes.Additive,
  });
  gestureClips.forEach(clip => {
    const {name} = clip;
    const config = gestureConfig[name];
    THREE.AnimationUtils.makeClipAdditive(clip);

    if (config !== undefined) {
      config.queueOptions.forEach((option, index) => {
        // Create a subclip for each range in queueOptions
        option.clip = THREE.AnimationUtils.subclip(
          clip,
          `${name}_${option.name}`,
          option.from,
          option.to,
          30
        );
      });
      host.AnimationFeature.addAnimation(
        'Gesture',
        name,
        HOST.anim.AnimationTypes.queue,
        config
      );
    } else {
      host.AnimationFeature.addAnimation(
        'Gesture',
        name,
        HOST.anim.AnimationTypes.single,
        {clip}
      );
    }
  });

  // Emote animations
  host.AnimationFeature.addLayer('Emote', {
    transitionTime: 0.5,
  });

  emoteClips.forEach(clip => {
    const {name} = clip;
    host.AnimationFeature.addAnimation(
      'Emote',
      name,
      HOST.anim.AnimationTypes.single,
      {clip, loopCount: 1}
    );
  });

  // Viseme poses
  host.AnimationFeature.addLayer('Viseme', {
    transitionTime: 0.12,
    blendMode: HOST.anim.LayerBlendModes.Additive,
  });
  host.AnimationFeature.setLayerWeight('Viseme', 0);

  // Slice off the reference frame
  const blendStateOptions = lipsyncClips.map(clip => {
    THREE.AnimationUtils.makeClipAdditive(clip);
    return {
      name: clip.name,
      clip: THREE.AnimationUtils.subclip(clip, clip.name, 1, 2, 30),
      weight: 0,
    };
  });
  host.AnimationFeature.addAnimation(
    'Viseme',
    'visemes',
    HOST.anim.AnimationTypes.freeBlend,
    {blendStateOptions}
  );
  host.AnimationFeature.playAnimation('Viseme', 'visemes');

  // POI poses
  poiConfig.forEach(config => {
    host.AnimationFeature.addLayer(config.name, {
      blendMode: HOST.anim.LayerBlendModes.Additive,
    });

    // Find each pose clip and make it additive
    config.blendStateOptions.forEach(clipConfig => {
      const clip = poiClips.find(clip => clip.name === clipConfig.clip);
      THREE.AnimationUtils.makeClipAdditive(clip);
      clipConfig.clip = THREE.AnimationUtils.subclip(
        clip,
        clip.name,
        1,
        2,
        30
      );
    });

    host.AnimationFeature.addAnimation(
      config.name,
      config.animation,
      HOST.anim.AnimationTypes.blend2d,
      {...config}
    );

    host.AnimationFeature.playAnimation(config.name, config.animation);

    // Find and store reference objects
    config.reference = character.getObjectByName(
      config.reference.replace(':', '')
    );
  });

  // Apply bindPoseOffset clip if it exists
  if (bindPoseOffset !== undefined) {
    host.AnimationFeature.addLayer('BindPoseOffset', {
      blendMode: HOST.anim.LayerBlendModes.Additive,
    });
    host.AnimationFeature.addAnimation(
      'BindPoseOffset',
      bindPoseOffset.name,
      HOST.anim.AnimationTypes.single,
      {
        clip: THREE.AnimationUtils.subclip(
          bindPoseOffset,
          bindPoseOffset.name,
          1,
          2,
          30
        ),
      }
    );
    host.AnimationFeature.playAnimation(
      'BindPoseOffset',
      bindPoseOffset.name
    );
  }

  // Set up Lipsync
  const visemeOptions = {
    layers: [{name: 'Viseme', animation: 'visemes'}],
  };
  const talkingOptions = {
    layers: [
      {
        name: 'Talk',
        animation: 'stand_talk',
        blendTime: 0.75,
        easingFn: HOST.anim.Easing.Quadratic.InOut,
      },
    ],
  };
  host.addFeature(
    HOST.LipsyncFeature,
    false,
    visemeOptions,
    talkingOptions
  );

  // Set up Gestures
  host.addFeature(HOST.GestureFeature, false, {
    layers: {
      Gesture: {minimumInterval: 3},
      Emote: {
        blendTime: 0.5,
        easingFn: HOST.anim.Easing.Quadratic.InOut,
      },
    },
  });

  // Set up Point of Interest
  host.addFeature(
    HOST.PointOfInterestFeature,
    false,
    {
      target: camera,
      lookTracker: lookJoint,
      scene,
    },
    {
      layers: poiConfig,
    },
    {
      layers: [{name: 'Blink'}],
    }
  );

  return host;
}

// Return the host whose name matches the text of the current tab
function getCurrentHost() {
  const name = "Maya";

  return {name, host: speakers.get(name)};
}

// Update UX with data for the current host
function toggleHost(evt) {
  const tab = evt.target;
  const allTabs = document.getElementsByClassName('tab');

  // Update tab classes
  for (let i = 0, l = allTabs.length; i < l; i++) {
    if (allTabs[i] !== tab) {
      allTabs[i].classList.remove('current');
    } else {
      allTabs[i].classList.add('current');
    }
  }

  // Show/hide speech input classes
  const {name, host} = getCurrentHost(speakers);
  const textEntries = document.getElementsByClassName('textEntry');

  for (let i = 0, l = textEntries.length; i < l; i += 1) {
    const textEntry = textEntries[i];

    if (textEntry.classList.contains(name)) {
      textEntry.classList.remove('hidden');
    } else {
      textEntry.classList.add('hidden');
    }
  }

  // Update emote selector
  const emoteSelect = document.getElementById('emotes');
  emoteSelect.length = 0;
  const emotes = host.AnimationFeature.getAnimations('Emote');
  emotes.forEach((emote, i) => {
    const emoteOption = document.createElement('option');
    emoteOption.text = emote;
    emoteOption.value = emote;
    emoteSelect.add(emoteOption, 0);

    // Set the current item to the first emote
    if (!i) {
      emoteSelect.value = emote;
    }
  });
}

async function main(callback) {

  const polly = new AWS.Polly();

  // Initialize AWS and create Polly service objects
  const presigner = new AWS.Polly.Presigner();


  const speechInit = HOST.aws.TextToSpeechFeature.initializeService(
    polly,
    presigner,
    window.AWS.VERSION
  );

  // Define the glTF assets that will represent the host
  const characterFile1 =
    './assets/glTF/characters/adult_female/maya/maya.gltf';
  const animationPath1 = './assets/glTF/animations/adult_female';
  const animationFiles = [
    'stand_idle.glb',
    'lipsync.glb',
    'gesture.glb',
    'emote.glb',
    'face_idle.glb',
    'blink.glb',
    'poi.glb',
  ];
  const gestureConfigFile = 'gesture.json';
  const poiConfigFile = 'poi.json';
  const audioAttachJoint1 = 'chardef_c_neckB'; // Name of the joint to attach audio to
  const lookJoint1 = 'charjx_c_look'; // Name of the joint to use for point of interest target tracking
  const voice1 = 'Joanna'; // Polly voice. Full list of available voices at: https://docs.aws.amazon.com/polly/latest/dg/voicelist.html
  const voiceEngine = 'Neural'; // Neural engine is not available for all voices in all regions: https://docs.aws.amazon.com/polly/latest/dg/NTTS-main.html

  // Set up the scene and host
  const {scene, camera, clock} = createScene();
  const {
    character: character1,
    clips: clips1,
    bindPoseOffset: bindPoseOffset1,
  } = await loadCharacter(
    scene,
    characterFile1,
    animationPath1,
    animationFiles
  );

  character1.position.set(0, 0, 0);
  character1.rotateY(-0.2);

  // Find the joints defined by name
  const audioAttach1 = character1.getObjectByName(audioAttachJoint1);
  const lookTracker1 = character1.getObjectByName(lookJoint1);

  // Read the gesture config file. This file contains options for splitting up
  // each animation in gestures.glb into 3 sub-animations and initializing them
  // as a QueueState animation.
  const gestureConfig1 = await fetch(
    `${animationPath1}/${gestureConfigFile}`
  ).then(response => response.json());

  // Read the point of interest config file. This file contains options for
  // creating Blend2dStates from look pose clips and initializing look layers
  // on the PointOfInterestFeature.
  const poiConfig1 = await fetch(
    `${animationPath1}/${poiConfigFile}`
  ).then(response => response.json());

  const [
    idleClips1,
    lipsyncClips1,
    gestureClips1,
    emoteClips1,
    faceClips1,
    blinkClips1,
    poiClips1,
  ] = clips1;
  const host1 = createHost(
    character1,
    audioAttach1,
    voice1,
    voiceEngine,
    idleClips1[0],
    faceClips1[0],
    lipsyncClips1,
    gestureClips1,
    gestureConfig1,
    emoteClips1,
    blinkClips1,
    poiClips1,
    poiConfig1,
    lookTracker1,
    bindPoseOffset1,
    clock,
    camera,
    scene
  );

  // Set up each host to look at the other when the other speaks and at the
  // camera when speech ends
  const onHost1StartSpeech = () => {
  };
  const onStopSpeech = () => {
    host1.PointOfInterestFeature.setTarget(camera);
  };

  host1.listenTo(
    host1.TextToSpeechFeature.EVENTS.play,
    onHost1StartSpeech
  );
  host1.listenTo(
    host1.TextToSpeechFeature.EVENTS.resume,
    onHost1StartSpeech
  );
  HOST.aws.TextToSpeechFeature.listenTo(
    HOST.aws.TextToSpeechFeature.EVENTS.pause,
    onStopSpeech
  );
  HOST.aws.TextToSpeechFeature.listenTo(
    HOST.aws.TextToSpeechFeature.EVENTS.stop,
    onStopSpeech
  );

  callback(true);

  document.getElementById('renderCanvas').style.display = '';

  await speechInit;

  speakers.set('Maya', host1);

}

function getTimeAndDate(){
  var now = moment();
  return now.format("H m on dddd do of MMMM YYYY")
}

function getMinutesAndSeconds(seconds){
  const minAndSec = [seconds / 60, seconds % 60].map(Math.floor)
  return ((minAndSec[0] < 10) ? '0' + minAndSec[0] : minAndSec[0])+"m:"+
         ((minAndSec[1] < 10) ? '0' + minAndSec[1] : minAndSec[1])+"s"
}

function getRandomNumberBetween(min,max){
    return Math.floor(Math.random()*(max-min+1)+min);
}

let sentences = {
  "neutral": [
        {text:"<speak>hmm. You are so quiet! What is the matter? </speak>", gesture:"bored"},
        {text:"<speak>umm. Do you want to talk more? </speak>", gesture:""},
        {text:"<speak>There is much to say. Anything you want talk about?</speak>", gesture:""},
  ],
  "negative":[
        {text:"<speak>hmm. Are you ok? Let's stay positive?</speak>", gesture:"cheer"},
        {text:"<speak>Cheer up. Why so negative?</speak>", gesture:""}
  ],
  "positive":[
        {text:"<speak>hmm. You are so quiet! What is the matter? Lost your tongue?</speak>", gesture:""},
        {text:"<speak>Wow. You are so positive!</speak>", gesture:"applause"}
  ]
}


function conversation(host, sentimentScore){

  if(host) {
    if(sentimentScore > 0.65 && sentimentScore < 1 && sentences.positive.length > 0) {
      if(sentences.positive[0].gesture !== ""){
        host.GestureFeature.playGesture('Emote', sentences.positive[0].gesture);
      }
      host.TextToSpeechFeature.play(sentences.positive[0].text)
      sentences.positive.shift();
    } else if(sentimentScore < 0.5 && sentimentScore > 0 && sentences.negative.length > 0) {
      if(sentences.negative[0].gesture !== ""){
        host.GestureFeature.playGesture('Emote', sentences.negative[0].gesture);
      }
      host.TextToSpeechFeature.play(sentences.negative[0].text)
      sentences.negative.shift();
    } else if(sentences.neutral.length > 0){
      if(sentences.neutral[0].gesture !== ""){
        host.GestureFeature.playGesture('Emote', sentences.neutral[0].gesture);
      }
      host.TextToSpeechFeature.play(sentences.neutral[0].text)
      sentences.neutral.shift();
    }
  }
}

Amplify.configure(awsconfig);

const renderFn = [];
const speakers = new Map([['Maya', undefined]]);
const streamer = new Streamer();
function App() {

  const [loaderScreen, setLoaderScreen] = useState(false);
  const [isRecording, setRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [sentimentScore, setSentimentScore] = useState(0);
  const [sentimentScores, setSentimentScores] = useState([]);
  const [speaking, setSpeaking] = useState(false);
  const [introCompleted, setIntroCompleted] = useState(false);
  const [emotion, setEmotion] = useState("");
  const [emotions, setEmotions] = useState([]);
  const startKeyPress = useKeyPress('s');
  const applauseKeyPress = useKeyPress('a');
  const boredKeyPress = useKeyPress('b');
  const cheerKeyPress = useKeyPress('c');

  useEffect(() => {
    const interval = setInterval(() => {
      if(isRecording) {
        setRecordingTime(recordingTime => recordingTime + 1);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [isRecording]);

  useEffect(() => {
    if(applauseKeyPress){
      const {host} = getCurrentHost(speakers);
      if(speakers){
        host.GestureFeature.playGesture('Emote', "applause");
        host.TextToSpeechFeature.play("<speak>Well done!</speak>")
      }
    }
  }, [applauseKeyPress]);

  useEffect(() => {
    if(boredKeyPress){
      const {host} = getCurrentHost(speakers);
      if(speakers){
        host.GestureFeature.playGesture('Emote', "bored");
        host.TextToSpeechFeature.play("<speak>I'm so bored!</speak>")
      }
    }
  }, [boredKeyPress]);

  useEffect(() => {
    if(cheerKeyPress){
      const {host} = getCurrentHost(speakers);
      if(speakers){
        host.TextToSpeechFeature.play("<speak>hip hip horay</speak>")
        host.GestureFeature.playGesture('Emote', "cheer");
      }
    }
  }, [cheerKeyPress]);

  useEffect(() => {
    if(startKeyPress){
      handleClick()
    }
  }, [startKeyPress]);

  useEffect(() => {
    setEmotions(ele=>{
      if(ele.length > 5) ele.shift()
      return ele.concat(emotion)
    })
    console.log("emotions", emotions)
  }, [emotion, emotions]);

  useEffect(() => {
    let counter = 0;
    let interval;
    if(speaking) {
      clearTimeout(interval);
    } else {
      if(introCompleted){
        interval = setTimeout(() => {
          if(!speaking && isRecording) {
            const { host } = getCurrentHost(speakers);
            if(host) conversation(host, sentimentScore)
          }
        }, getRandomNumberBetween(3000,4500));
      }
    }
    return () => clearTimeout(interval);
  }, [speaking, introCompleted]);

  useEffect(() => {
    let average = (array) => {
      var i = 0, sum = 0, len = array.length;
      if(array.length > 0) {
        while (i < len) {
            sum = sum + array[i++];
        }
        return sum / len;
      } else return 0;
    };

    const avg = average(sentimentScores)
    setSentimentScore(avg);


  }, [sentimentScores]);

  const [startButtonText, setStartButtonText] = useState("Start your diary session");

  function handleClick(e) {
    if(e) e.preventDefault();

    const {name, host} = getCurrentHost(speakers);
    const speechInput = "<speak>Dear Emily. Welcome back to your daily diary session. Let me note the time. It is now "+getTimeAndDate()+". For your convience I will record this session with video and audio. Let's begin. How are you today?</speak>"

    const emotes = host.AnimationFeature.getAnimations('Emote');

    if(!isRecording) {
      setRecordingTime(0)
      setRecording(true)
      setStartButtonText("Stop your diary session")
      streamer.startStreaming({
       setSentimentScore:setSentimentScore,
       sentimentScore:sentimentScore,
       setSentimentScores: (data) => {
         setSentimentScores((prevRecords => ([...prevRecords, data])))

       },
       speakingCallback: (isSpeaking) => {
         setSpeaking(isSpeaking)
       },
       emotionCallback: (emotion) => {
         setEmotion(emotion)
       }
      })

      host.TextToSpeechFeature.play(speechInput).then(response => {
        setIntroCompleted(true)
      }).catch(e => {
        console.log("Error TexttoSpeech");
      });

    } else {
      streamer.closeSocket();
      streamer.closeVideoSocket();
      setRecording(false)
      setStartButtonText("Start your diary session")
      host.TextToSpeechFeature.stop();

    }

    //host.GestureFeature.playGesture('Emote', "cheer");
  }

  useEffect(() => {
    main(setLoaderScreen);
  }, []); // Only re-run the effect if count changes

  return (
    <div id="container" style={{height:"100%"}}>
      {!loaderScreen &&
      <div id="loadScreen">
        <div id="loader"></div>
      </div>
      }
      {loaderScreen &&
      <div id="startTalking">
        <button onClick={handleClick} className="speechButton">
          {startButtonText}
        </button>
        <p>Recording time: {getMinutesAndSeconds(recordingTime)}</p>
        <p>Sentiment Score: {sentimentScore.toFixed(2)}</p>
        <div style={{height:"38px"}}>
          <Sparklines data={sentimentScores} limit={10} width={100} height={20} margin={5}>
            <SparklinesLine color="rgb(0, 142, 174)" />
          </Sparklines>
        </div>
        <div>
          <p style={{margin:0}}>Emotion Score: <span className="emoji">{emotion}</span></p>
        </div>
          <p className="emojihistory">{emotions.map((value, index) => (
              <span key={index}>
              {value}
              </span>
            ))}
          </p>
      </div>
      }
      {(loaderScreen && isRecording) &&
      <div id="recording">
        <img src={recording} alt="recording" />
      </div>
      }
    </div>
  );
}

export default App;
