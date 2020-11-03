# Hack Server

import json
import time
from datetime import datetime
import socketio

from aiohttp import web

from PIL import Image, ImageMode
import io

connected = False
counter = 0

sio = socketio.AsyncServer(cors_allowed_origins='*')

app = web.Application()

app.add_routes([web.static('/app', 'www')])

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

    print("Socket ID: " , sid)

    timestamp = datetime.timestamp(datetime.now())

    image = Image.open(io.BytesIO(message))

    file_name = str(timestamp) + '.jpg'

    print('received file: ', file_name)

    image.save('/home/ubuntu/github/hackathon/backend/www/data/' + file_name, "JPEG")

    await sio.emit('image_path', 'http://ec2-34-251-228-120.eu-west-1.compute.amazonaws.com:8080/app/data/' + file_name)

if __name__ == '__main__':
    web.run_app(app)
    