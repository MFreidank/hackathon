# Hack Server

import json
import time
from datetime import datetime
import socketio

from aiohttp import web
from aio_timers import Timer

connected = False
counter = 0

sio = socketio.AsyncServer()

app = web.Application()

app.add_routes([web.static('/app', 'www')])

sio.attach(app)

@sio.event
async def connect(sid, environ):

    global connected

    print('connect ', sid)
    connected = True

    Timer(1, send_count, callback_async=True)

async def send_count():

    global counter

    if connected is True:

        await sio.emit('send_count', counter)
        print('sent count: ', counter)
        counter = counter + 1

        Timer(1, send_count, callback_async=True)

@sio.event
def disconnect(sid):

    global connected
    
    print('disconnect ', sid)
    connected = False

@sio.on('message')
async def print_message(sid, message):

    print("Socket ID: " , sid)
    print(message)

    timestamp = datetime.timestamp(datetime.now())

    await sio.emit('pong', timestamp)

if __name__ == '__main__':
    web.run_app(app)
    