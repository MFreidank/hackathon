# Hack Server

import json
from os import path
from datetime import datetime
import socketio
import tempfile
import time

from aiohttp import web

from PIL import Image, ImageMode
import io

import emotion_detection
from emotion_detection.modeling import load_trained_model, MODEL_DIRECTORY
from emotion_detection.face_detection import NoFaceDetectedError


# NOTE: Pre-load model to improve performance
MODEL = load_trained_model(
    model_path=path.join(MODEL_DIRECTORY, "FER_trained_model.pt")
)


connected = False

sio = socketio.AsyncServer(cors_allowed_origins='*')

app = web.Application()

# bugbug disable show_index before we start uploading more files
app.add_routes([web.static('/app', 'www', show_index=True)])

sio.attach(app)

@sio.event
async def connect(sid, environ):

    global connected

    print('connect ', sid)
    connected = True

@sio.event
def disconnect(sid):

    global connected
    
    print('disconnect ', sid)
    connected = False

@sio.on('message')
async def print_message(sid, message):
    global MODEL

    print("Socket ID: " , sid)

    image = Image.open(io.BytesIO(message))

    with tempfile.NamedTemporaryFile(suffix=".jpg") as temp_file:
        image.save(temp_file.name, "JPEG")
        print('received file: ', temp_file.name)

        await sio.emit('image_path', temp_file.name)

        print("Starting emotion detection")

        try:
            detected_emotion, detection_confidence = emotion_detection.detect_from_image_file(
                img_path=temp_file.name
                model=MODEL,
            )
        except NoFaceDetectedError:  # NOTE: Could not reliably detect face in the given image frame
            print(f"Failed to detect emotion")
            await sio.emit("detected_emotion", "Failed to detect face")
        else:
            print(f"Detected emotion as {detected_emotion}")
            await sio.emit("detected_emotion", detected_emotion)

if __name__ == '__main__':
    web.run_app(app)
    
