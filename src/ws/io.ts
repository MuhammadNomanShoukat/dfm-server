let ioRef: import('socket.io').Server | null = null;

export function setIo(io: import('socket.io').Server): void {
  ioRef = io;
}

export function getIo(): import('socket.io').Server | null {
  return ioRef;
}
