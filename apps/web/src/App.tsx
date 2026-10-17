import { useEffect, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_ROOM,
  participantSchema,
  type ClientEvents,
  type RoomSession,
  type ServerEvents,
} from '@temp-chat/protocol';
import { API_URL, postSession } from './api';
import {
  decrypt,
  deriveKeys,
  encrypt,
  inviteUrl,
  newInviteSecret,
  parseInvite,
  type Invite,
} from './crypto';
import {
  forgetSession,
  loadSession,
  saveSession,
  type SavedSession,
} from './session';

interface ActiveSession extends SavedSession {
  encryptionKey: CryptoKey;
}
interface Message {
  id: string;
  text: string;
  own: boolean;
  status: string;
}

function initialState() {
  try {
    const invite = parseInvite(window.location.hash);
    const saved = loadSession();
    return {
      invite,
      saved: !invite || invite.roomId === saved?.room.roomId ? saved : undefined,
      error: '',
    };
  } catch {
    return {
      invite: undefined,
      saved: undefined,
      error: 'Invitation or saved session is invalid. Clear it to start a new room.',
    };
  }
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Unexpected error. Please try again.';

export function App() {
  const [initial] = useState(initialState);
  const [invite, setInvite] = useState<Invite | undefined>(initial.invite);
  const [saved, setSaved] = useState(initial.saved);
  const [active, setActive] = useState<ActiveSession>();
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const joining = Boolean(invite && !saved);

  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash) window.location.reload();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  async function openRoom(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const secret = saved?.secret ?? invite?.secret ?? newInviteSecret();
      const keys = await deriveKeys(secret, passphrase);
      let room: RoomSession;
      if (saved) {
        if (keys.guestAccessToken !== saved.keyCheck) {
          throw new Error('Incorrect passphrase for this saved session.');
        }
        room = saved.room;
      } else if (invite) {
        room = await postSession(`/rooms/${invite.roomId}/join`, {
          guestAccessToken: keys.guestAccessToken,
        });
      } else {
        room = await postSession('/rooms', { guestAccessToken: keys.guestAccessToken });
      }
      const session: SavedSession = { room, secret, keyCheck: keys.guestAccessToken };
      try {
        saveSession(session);
      } catch {
        setNotice('Browser storage is unavailable. This session cannot survive a reload.');
      }
      setSaved(session);
      setActive({ ...session, encryptionKey: keys.encryptionKey });
      setPassphrase('');
      window.history.replaceState(null, '', window.location.pathname);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    if (!window.confirm('Forget this tab session? Its participant slot cannot be reclaimed without its credentials.')) return;
    try {
      forgetSession();
      window.history.replaceState(null, '', window.location.pathname);
      setActive(undefined);
      setSaved(undefined);
      setInvite(undefined);
      setPassphrase('');
      setError('');
      setNotice('');
    } catch (error) {
      setError(`Could not forget the session: ${errorText(error)}`);
    }
  }

  return (
    <main className="shell">
      <header className="masthead">
        <a href="/" className="brand"><span className="brand-mark">t.</span> temporary chat</a>
        <span className="pill">JUST BETWEEN TWO</span>
      </header>
      {active ? (
        <Chat session={active} onForget={reset} />
      ) : (
        <section className="landing">
          <div className="intro">
            <p className="eyebrow">A LITTLE SPACE. NOT A PERMANENT RECORD.</p>
            <h1>Here for the<br />conversation.<br /><span>Gone in an hour.</span></h1>
            <p className="lede">A private room for two. Encrypted in your browser. No accounts, no server-side chat history.</p>
            <div className="principles">
              <div><strong>02</strong><span>people, always</span></div>
              <div><strong>60</strong><span>minutes, then closed</span></div>
              <div><strong>00</strong><span>messages stored by us</span></div>
            </div>
          </div>
          <form className="card setup" onSubmit={(event) => void openRoom(event)}>
            <p className="eyebrow">YOUR CONVERSATION STARTS HERE</p>
            <h2>{saved ? 'Welcome back.' : joining ? 'You have an invitation.' : 'Make a little room.'}</h2>
            <p className="muted">
              {saved
                ? 'Enter your original passphrase to unlock this tab session. Previous messages are not restored.'
                : joining
                  ? 'Ask the sender for the passphrase using a different, secure channel.'
                  : 'Share the invitation link normally. Share this passphrase separately, through a more secure channel.'}
            </p>
            <label htmlFor="passphrase">Room passphrase</label>
            <input
              id="passphrase"
              type={showPassphrase ? 'text' : 'password'}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              minLength={16}
              maxLength={256}
              autoComplete={saved || joining ? 'current-password' : 'new-password'}
              placeholder="At least 16 characters"
              required
              disabled={busy}
            />
            <div className="input-options">
              <label className="check"><input type="checkbox" checked={showPassphrase} onChange={(event) => setShowPassphrase(event.target.checked)} /> Show passphrase</label>
              {!saved && !joining && (
                <button type="button" className="text-button" disabled={busy} onClick={() => {
                  try {
                    setPassphrase(newInviteSecret());
                    setShowPassphrase(true);
                  } catch (error) { setError(errorText(error)); }
                }}>Generate strong</button>
              )}
            </div>
            <p className="hint">Use a unique, randomly generated passphrase or several random words. Save it before continuing; we cannot recover it.</p>
            <button className="primary" disabled={busy || Boolean(initial.error && !saved && !invite && error)} type="submit">
              {busy ? 'Preparing encryption...' : saved ? 'Reconnect to room' : joining ? 'Unlock & join room' : 'Create private room'}
              <span aria-hidden="true">&rarr;</span>
            </button>
            {(saved || invite || initial.error) && <button type="button" className="text-button reset" onClick={reset} disabled={busy}>Forget invitation / saved session</button>}
          </form>
        </section>
      )}
      {error && <p className="alert error" role="alert">{error}</p>}
      {notice && <p className="alert" role="status">{notice}</p>}
      <footer>
        <span>Private by design. Temporary by default.</span>
        <p>Participants can save or screenshot messages. Encryption does not protect a compromised device or a maliciously modified website. No forward secrecy.</p>
      </footer>
    </main>
  );
}

function Chat({ session, onForget }: { session: ActiveSession; onForget: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('Connecting');
  const [peerOnline, setPeerOnline] = useState(false);
  const [connected, setConnected] = useState(false);
  const [expired, setExpired] = useState(false);
  const [replaced, setReplaced] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const socketRef = useRef<Socket<ServerEvents, ClientEvents>>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<string>());
  const serverClock = useRef({ at: performance.now(), time: Date.parse(session.room.serverTime) });

  useEffect(() => {
    let alive = true;
    let closed = false;
    let timer: number | undefined;
    const { roomId, token, participant } = session.room;
    const socket: Socket<ServerEvents, ClientEvents> = io(API_URL, {
      auth: { roomId, token },
      transports: ['websocket'],
      autoConnect: false,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;
    const expire = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      setExpired(true);
      setConnected(false);
      setPeerOnline(false);
      setStatus('Room expired');
      setDraft('');
      setMessages([]);
      seen.current.clear();
      socket.disconnect();
      try { forgetSession(); } catch { setError('Room expired, but browser storage could not be cleared.'); }
    };
    socket.on('connect', () => {
      setStatus('Authorizing');
      socket.timeout(8000).emit('ready', (timeoutError, result) => {
        if (!alive) return;
        if (timeoutError || !result?.ok) {
          setError(timeoutError
            ? 'Session authorization timed out. Reconnect to try again.'
            : result && !result.ok ? result.error : 'Session authorization failed.');
          setStatus('Disconnected');
          setConnected(false);
          return;
        }
        serverClock.current = { at: performance.now(), time: Date.parse(result.data.serverTime) };
        setConnected(true);
        setPeerOnline(result.data.peerOnline);
        setStatus('Connected');
        setError('');
      });
    });
    socket.on('connect_error', (error) => {
      setConnected(false);
      setStatus('Connection failed');
      setError(error.message);
    });
    socket.on('disconnect', (reason) => {
      setConnected(false);
      setPeerOnline(false);
      if (reason !== 'io client disconnect') setStatus('Disconnected');
    });
    socket.on('presence', ({ peerOnline }) => setPeerOnline(peerOnline));
    socket.on('expired', expire);
    socket.on('replaced', () => {
      setReplaced(true);
      setConnected(false);
      setStatus('Session opened in another tab');
      setError('Another connection is using this participant slot. Close it before reconnecting.');
      socket.disconnect();
    });
    socket.on('message', async (message, ack) => {
      if (typeof ack !== 'function') return;
      const parsedSender = participantSchema.safeParse(message.sender);
      if (!parsedSender.success || parsedSender.data === participant) {
        ack({ ok: false, error: 'Invalid sender.' });
        return;
      }
      if (seen.current.has(message.id)) {
        ack({ ok: false, error: 'Duplicate message rejected.' });
        return;
      }
      if (seen.current.size >= MAX_MESSAGES_PER_ROOM) {
        ack({ ok: false, error: 'Message limit reached.' });
        return;
      }
      seen.current.add(message.id);
      try {
        const text = await decrypt(session.encryptionKey, roomId, parsedSender.data, message);
        if (!alive || !socket.connected) return;
        setMessages((current) => [...current, { id: message.id, text, own: false, status: 'Received' }]);
        ack({ ok: true, data: undefined });
      } catch {
        seen.current.delete(message.id);
        setError('An incoming message failed authentication. Check the passphrase; the message was not displayed.');
        ack({ ok: false, error: 'Message authentication failed.' });
      }
    });
    const tick = () => {
      const clock = serverClock.current;
      const now = clock.time + performance.now() - clock.at;
      const ms = Date.parse(session.room.expiresAt) - now;
      setRemaining(Math.max(0, Math.ceil(ms / 1000)));
      if (ms <= 0) expire();
    };
    socket.connect();
    timer = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = undefined;
    };
  }, [session]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const socket = socketRef.current;
    if (sending || !connected || !peerOnline || !socket || expired) return;
    const text = draft;
    setSending(true);
    setError('');
    try {
      const envelope = await encrypt(session.encryptionKey, session.room.roomId, session.room.participant, text);
      setMessages((current) => [...current, { id: envelope.id, text, own: true, status: 'Delivering' }]);
      setDraft('');
      socket.timeout(10_000).emit('message', envelope, (timeoutError, result) => {
        const confirmed = !timeoutError && result?.ok;
        const failure = timeoutError
          ? 'Delivery not confirmed. The peer may have received the message.'
          : !result?.ok ? result?.error ?? 'Delivery failed.' : '';
        setMessages((current) => current.map((message) =>
          message.id === envelope.id ? { ...message, status: confirmed ? 'Delivered' : 'Not confirmed' } : message,
        ));
        if (failure) setError(failure);
        setSending(false);
      });
    } catch (error) {
      setError(errorText(error));
      setSending(false);
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl({ roomId: session.room.roomId, secret: session.secret }));
      setNotice('Invitation copied. Share the passphrase separately.');
    } catch {
      setError('Clipboard unavailable. Select and copy the invitation link manually.');
    }
  }

  return (
    <section className="room-layout">
      <aside className="room-sidebar">
        <p className="eyebrow">YOUR TEMPORARY SPACE</p>
        <h1>Just us.<br /><span>Just now.</span></h1>
        <div className="timer" aria-label="Time remaining">{String(Math.floor(remaining / 60)).padStart(2, '0')}<span>:</span>{String(remaining % 60).padStart(2, '0')}</div>
        <p className="muted">Room closes automatically. The clock doesn't reset when you reconnect.</p>
        <div className="room-info">
          <p><span className={`dot ${connected ? 'online' : ''}`} /> You &middot; {status.toLowerCase()}</p>
          <p><span className={`dot ${peerOnline ? 'online' : ''}`} /> {peerOnline ? 'Your person is here' : 'Waiting for your person'}</p>
        </div>
        {session.room.participant === 'creator' && !expired && (
          <div className="invite-box">
            <label htmlFor="invite">Invitation link</label>
            <input id="invite" readOnly value={inviteUrl({ roomId: session.room.roomId, secret: session.secret })} onFocus={(event) => event.target.select()} />
            <button className="secondary" onClick={() => void copyInvite()}>Copy invitation</button>
            <p className="hint">The link alone isn't enough. Send your passphrase via a different, secure channel.</p>
          </div>
        )}
        {!connected && !expired && !replaced && <button className="secondary" onClick={() => {
          setError('');
          socketRef.current?.disconnect().connect();
        }}>Reconnect</button>}
        <button className="text-button reset" onClick={onForget}>Forget this tab session</button>
      </aside>
      <div className="card chat">
        <div className="chat-heading"><div><h2>Off the record.</h2><span className="muted">Browser-encrypted &middot; two participants</span></div><span className="lock-badge">E2EE</span></div>
        <div className="messages" role="log" aria-label="Chat messages" aria-live="polite">
          {!messages.length && <div className="empty"><span className="empty-icon" aria-hidden="true">&bull; &bull; &bull;</span><h3>{expired ? 'This room has closed.' : 'Nothing here but possibility.'}</h3><p>{expired ? 'Start a new room for a fresh conversation.' : 'Messages live only in this open page. Offline messages are never queued.'}</p></div>}
          {messages.map((message) => (
            <div key={message.id} className={`message ${message.own ? 'own' : ''}`}>
              <span className="message-author">{message.own ? 'You' : 'Your person'}</span>
              <p>{message.text}</p>
              <span className="message-status">{message.status}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
        {error && <p role="alert" className="chat-alert">{error}</p>}
        {notice && <p role="status" className="chat-alert notice">{notice}</p>}
        <form className="composer" onSubmit={(event) => void send(event)}>
          <label className="sr-only" htmlFor="message">Your message</label>
          <textarea id="message" rows={2} placeholder={expired ? 'This room has expired.' : peerOnline ? 'Say something worth not keeping...' : 'Waiting for your person to connect...'} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={MAX_MESSAGE_BYTES} disabled={!connected || !peerOnline || expired || sending} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} />
          <button className="primary" type="submit" disabled={!connected || !peerOnline || expired || sending || !draft.trim()}>{sending ? 'Sending...' : 'Send'} <span aria-hidden="true">&uarr;</span></button>
        </form>
        <p className="composer-hint">Enter to send &middot; Shift + Enter for a new line &middot; up to 4,000 UTF-8 bytes</p>
      </div>
    </section>
  );
}
