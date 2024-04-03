import { EventEmitter } from 'events'
import { WebSocket } from 'ws'

interface SocketMessage {
	event: 'media' | 'mark' | 'clear';
	media?: {
		payload: string
	}
	mark?: {
		name: string
	}
}

interface CallMediaQueueArgs {
	streamSid: string;
	socket: WebSocket
}

class CallMediaQueue extends EventEmitter {

	private queue: SocketMessage[]
	private isSending: boolean
	private streamSid: string
	private socket: WebSocket
	private channels: number 	 	// 1 channel for mono audio
	private sampleRate: number 		// 16000 Hz
	private bytesPerSample: number	// 2 bytes per sample for 16-bit PCM
	private packetDuration: number	// duration of each packet in ms. Calculated later
	private volumeLevel: number		// volume level of the audio stream
	private bufferLimit: number		// maximum number of packets to buffer

	constructor(args: CallMediaQueueArgs) {
		super()
		this.queue = []
		this.isSending = false
		this.streamSid = args.streamSid
		this.socket = args.socket
		
		// audio format
		this.channels = 1			// mono audio
		this.sampleRate = 16000		// 16 kHz
		this.bytesPerSample = 2		// 16-bit PCM

		// audio processing
		this.packetDuration = 0
		this.volumeLevel = 1
		this.bufferLimit = 1000;	// arbitrary limit to prevent memory issues

		this.socket.on('error', (error) => {
			console.error(`WebSocket Error: ${error}`);
			// TODO: Implement error strategy
		});

		this.socket.on('message', async (message) => {
			try {
				const data = JSON.parse(message.toString())

				switch (data.event) {
					case 'mark': {
						this.emit('mark', data.mark.name)
						break
					}
				}
			}
			catch (error) {
				console.error(`Error parsing message data: ${error}`);
				// TODO: Implement error strategy
			}
		})
	}

	private processNext(): void {		
        if (!this.isSending && this.queue.length > 0) {
            this.isSending = true
            // Delaying the process to ensure packets are sent in real-time
            setTimeout(() => {
                this.sendNext()
            }, this.packetDuration)
        }
    }

	private sendNext(): void {
		if (this.queue.length === 0) {
			// End of packets
			this.isSending = false;
			this.packetDuration = 0;
			return
		}
	
		try {
			const socketMessage = this.queue.shift();
		
			if (socketMessage) {
				if (socketMessage?.media?.payload) {
					// Determine the duration of the packet from the payload size (from bytes to milliseconds)
					// Then use the duration to send the packet in real-time
					const payloadBuffer = Buffer.from(socketMessage.media.payload, 'base64');
					const numberOfSamples = payloadBuffer.length / (this.channels * this.bytesPerSample);
					this.packetDuration = (numberOfSamples / this.sampleRate) * 1000 // converting seconds to milliseconds
				}
			
				this.sendToTwilio(socketMessage);
			}
		
			this.isSending = false;
			this.processNext();
		}
		catch (error) {
			console.error(`Error sending audio packet: ${error}`);
			// TODO: Implement error strategy
		}
	}

	// Sends audio to Twilio as it arrives– faster than real-time
	private sendToTwilio(socketMessage: SocketMessage) {
		this.socket.send(
			JSON.stringify({
				event: socketMessage.event,
				streamSid: this.streamSid,
				media: socketMessage.media,
				mark: socketMessage.mark,
			})
		)
	}

	private clearQueue(): void {
		this.queue = []
	}

	private enqueue(mediaData: SocketMessage): void {
		if (this.queue.length >= this.bufferLimit) {
			// Buffer limit reached.
			// For now, we simply return and ignore/drop additional packets.
			// TODO: Implement a strategy to handle this scenario.
			console.warn('Buffer limit reached. Incoming packet dropped.');
			return;
		}

		if (this.volumeLevel === 1 && mediaData.media) {
			const payloadBuffer = Buffer.from(mediaData.media.payload, 'base64');
			const adjustedBuffer = this.adjustVolume(payloadBuffer);
			mediaData.media.payload = adjustedBuffer.toString('base64');
		}

		this.queue.push(mediaData)
		this.processNext()
	}

	private adjustVolume(audioData: Buffer): Buffer {
		// In digital audio processing, a volume level, or gain factor, 
		// of 1 means no change to the original volume. When each sample 
		// in the audio signal is multiplied by a gain of 1, the resulting 
		// value is the same as the original.
		if (this.volumeLevel === 1) {
			return audioData;
		}

		try {
			const newAudioData = Buffer.alloc(audioData.length);
	
			for (let i = 0; i < audioData.length; i += 2) {
				if (i + 1 < audioData.length) {
					const sample = audioData.readInt16LE(i);
					let newSample = Math.floor(sample * this.volumeLevel);
					
					// Clipping the audio signal to prevent distortion
					newSample = Math.min(Math.max(newSample, -32768), 32767);
			
					newAudioData.writeInt16LE(newSample, i);
				}
			}
	
			return newAudioData;
		}
		catch (error) {
			console.error(`Error during audio processing: ${error}`);
			throw error;
	  	}
	}

	// New audio payload available
	media(payload: string): void {
		this.enqueue({
			event: 'media',
			media: {
				payload,
			},
		})
	}

	// Mark a point in the audio stream since Twilio handles the audio buffer and we can't control the timing
	// Once we send audio in real-time, we can remove this method or use it locally.\
	mark(name: string): void {
		this.enqueue({
			event: 'mark',
			mark: {
				name,
			},
		})
	}

	// Clear the audio queue with Twilio. When we send in real-time, we can remove this method or use it locally.
	clear(): void {
		this.sendToTwilio({ event: 'clear' })
		this.clearQueue()
	}

	// Set the volume of the audio stream, 0-1
	setVolume(volume: number): void {
		if (typeof volume !== 'number' || volume < 0 || volume > 1) {
			throw new Error('Invalid volume level. It should be a number between 0 and 1.');
		}		

		this.volumeLevel = Math.max(0, Math.min(1, volume));
	}

	// Set the buffer limit to prevent memory issues
	setBufferLimit(limit: number): void {
		if (typeof limit !== 'number' || limit < 0) {
			throw new Error('Invalid buffer limit. It should be a positive number.');
		}

		this.bufferLimit = limit;
	}

}

export default CallMediaQueue
