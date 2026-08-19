import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env, isAllowedOrigin } from '../config/env.js';
import { setIo } from './io.js';

export function attachSocket(httpServer: HttpServer): void {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error('Origin not allowed'));
      },
      credentials: true,
    },
  });
  setIo(io);

  io.use((socket, next) => {
    const cookie = socket.handshake.headers.cookie ?? '';
    const match = cookie.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${env.COOKIE_NAME}=`));
    const token = match?.split('=')[1];
    if (!token) {
      next(new Error('unauthenticated'));
      return;
    }
    try {
      jwt.verify(token, env.JWT_SECRET);
      next();
    } catch {
      next(new Error('unauthenticated'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('join-farm', (farmId: string) => {
      if (typeof farmId === 'string' && farmId.length > 10) {
        void socket.join(`farm:${farmId}`);
      }
    });
  });
}
