const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

const BOT_NAMES = ["Sofia (bot)", "Andrea (bot)", "Chiara (bot)", "Matteo (bot)", "Elena (bot)"];

const ROLE_INFO = {
  professore: {
    name: "Professore",
    team: "lupi",
    desc: "Sei un Professore di Architettura a Valle Giulia… e di notte diventi Lupo. Insieme all’altro Professore scegliete ogni notte uno studente da eliminare. Di giorno fingete di essere innocenti."
  },
  fuoricorso: {
    name: "Fuoricorso",
    team: "villaggio",
    desc: "Sei il Fuoricorso. Ogni notte puoi indagare su un giocatore e scoprire se è un Professore (Lupo) o uno Studente."
  },
  assistente: {
    name: "Assistente",
    team: "villaggio",
    desc: "Sei l’Assistente. Ogni notte puoi proteggere un giocatore (anche te stesso). Non puoi proteggere la stessa persona due notti di fila."
  },
  studente: {
    name: "Studente di Architettura",
    team: "villaggio",
    desc: "Sei uno Studente di Architettura. Nessun potere speciale. Sopravvivi e trova i Professori-lupi."
  }
};

// roomId -> room state
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createRoom(hostSocketId, hostName) {
  let code;
  do { code = generateCode(); } while (rooms[code]);

  const room = {
    code,
    hostId: hostSocketId,
    phase: 'lobby', // lobby | night | day | end
    night: 1,
    day: 1,
    players: [],
    votes: {},
    nightActions: { protect: null, seer: null, kill: null },
    lastProtectedId: null,
    history: [],
    log: [],
    winner: null,
    createdAt: Date.now()
  };

  // Aggiungi host
  room.players.push({
    id: hostSocketId,
    name: hostName,
    role: null,
    alive: true,
    isBot: false,
    isHost: true,
    connected: true
  });

  rooms[code] = room;
  return room;
}

function getPublicState(room, forPlayerId = null) {
  const me = room.players.find(p => p.id === forPlayerId);
  return {
    code: room.code,
    phase: room.phase,
    night: room.night,
    day: room.day,
    winner: room.winner,
    log: room.log.slice(-15),
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      isBot: p.isBot,
      isHost: p.isHost,
      connected: p.connected,
      // ruolo solo a se stesso o a fine partita
      role: (p.id === forPlayerId || room.phase === 'end') ? p.role : null,
      roleName: (p.id === forPlayerId || room.phase === 'end') ? (ROLE_INFO[p.role]?.name || null) : null
    })),
    myRole: me ? me.role : null,
    myRoleInfo: me && me.role ? ROLE_INFO[me.role] : null,
    isHost: me ? me.isHost : false,
    canAct: false, // calcolato lato client in base al ruolo e fase
    votesCount: Object.keys(room.votes).length,
    totalAlive: room.players.filter(p => p.alive).length,
    lastKill: room.lastKill || null,
    history: room.history
  };
}

function broadcastRoom(room) {
  room.players.filter(p => !p.isBot && p.connected).forEach(p => {
    io.to(p.id).emit('state', getPublicState(room, p.id));
  });
}

function addBots(room) {
  const needed = 5 - (room.players.filter(p => !p.isBot).length - 3); // aspettiamo 3 umani, ma se ne entrano meno riempiamo
  // Sempre 5 bot per arrivare a 8
  while (room.players.filter(p => p.isBot).length < 5) {
    const botName = BOT_NAMES[room.players.filter(p => p.isBot).length];
    room.players.push({
      id: 'bot_' + Math.random().toString(36).slice(2, 9),
      name: botName,
      role: null,
      alive: true,
      isBot: true,
      isHost: false,
      connected: true
    });
  }
}

function assignRoles(room) {
  const roles = shuffle([
    'professore', 'professore',
    'fuoricorso',
    'assistente',
    'studente', 'studente', 'studente', 'studente'
  ]);
  room.players.forEach((p, i) => {
    p.role = roles[i];
  });
}

function alive(room) {
  return room.players.filter(p => p.alive);
}

function aliveWolves(room) {
  return alive(room).filter(p => p.role === 'professore');
}

function aliveVillagers(room) {
  return alive(room).filter(p => p.role !== 'professore');
}

function checkWin(room) {
  const wolves = aliveWolves(room).length;
  const villagers = aliveVillagers(room).length;
  if (wolves === 0) {
    room.phase = 'end';
    room.winner = 'villaggio';
    room.log.unshift('Gli Studenti hanno smascherato i Professori!');
    return true;
  }
  if (wolves >= villagers) {
    room.phase = 'end';
    room.winner = 'lupi';
    room.log.unshift('I Professori dominano Valle Giulia!');
    return true;
  }
  return false;
}

function resolveNight(room) {
  const { protect, kill } = room.nightActions;

  // Bot actions se non fatte
  if (protect === null) {
    const guard = room.players.find(p => p.role === 'assistente' && p.alive);
    if (guard) {
      const candidates = alive(room).filter(p => p.id !== room.lastProtectedId);
      if (candidates.length) {
        room.nightActions.protect = candidates[Math.floor(Math.random() * candidates.length)].id;
      }
    }
  }
  if (kill === null) {
    const wolves = aliveWolves(room);
    if (wolves.length) {
      const targets = aliveVillagers(room);
      const humans = targets.filter(p => !p.isBot);
      const pool = humans.length && Math.random() < 0.6 ? humans : targets;
      if (pool.length) {
        room.nightActions.kill = pool[Math.floor(Math.random() * pool.length)].id;
      }
    }
  }

  const victimId = room.nightActions.kill;
  const protectId = room.nightActions.protect;

  if (victimId) {
    if (protectId === victimId) {
      room.log.unshift(`🛡️ Notte ${room.night}: l'Assistente ha sventato l'attacco!`);
      room.history.push({ type: 'night', night: room.night, victim: null, note: 'protetto' });
      room.lastKill = null;
    } else {
      const victim = room.players.find(p => p.id === victimId);
      if (victim) {
        victim.alive = false;
        room.lastKill = victim.name;
        room.history.push({ type: 'night', night: room.night, victim: victim.name, role: victim.role });
        room.log.unshift(`🐺 Notte ${room.night}: ${victim.name} è stato eliminato dai Professori.`);
      }
    }
  }

  room.lastProtectedId = protectId;
  room.nightActions = { protect: null, seer: null, kill: null };

  if (checkWin(room)) {
    broadcastRoom(room);
    return;
  }

  room.phase = 'day';
  room.log.unshift(`☀️ Inizia il Giorno ${room.day}`);
  broadcastRoom(room);
}

function resolveVotes(room) {
  const counts = {};
  Object.values(room.votes).forEach(tid => {
    counts[tid] = (counts[tid] || 0) + 1;
  });

  let max = 0, winners = [];
  for (const [id, c] of Object.entries(counts)) {
    if (c > max) { max = c; winners = [id]; }
    else if (c === max) winners.push(id);
  }

  if (winners.length === 1) {
    const victim = room.players.find(p => p.id === winners[0]);
    if (victim) {
      victim.alive = false;
      room.history.push({ type: 'day', day: room.day, victim: victim.name, role: victim.role });
      room.log.unshift(`☀️ Giorno ${room.day}: ${victim.name} (${ROLE_INFO[victim.role].name}) eliminato dal voto.`);
    }
  } else {
    room.log.unshift(`☀️ Giorno ${room.day}: votazione in pareggio, nessuno eliminato.`);
  }

  room.votes = {};

  if (checkWin(room)) {
    broadcastRoom(room);
    return;
  }

  // Prossima notte
  room.night++;
  room.day++;
  room.phase = 'night';
  room.lastKill = null;
  room.log.unshift(`🌙 Inizia la Notte ${room.night}`);
  broadcastRoom(room);

  // Se non ci sono umani con azioni, risolvi automaticamente dopo un po'
  setTimeout(() => {
    if (room.phase === 'night') {
      const needsHuman = room.players.some(p => p.alive && !p.isBot && 
        (p.role === 'professore' || p.role === 'fuoricorso' || p.role === 'assistente'));
      if (!needsHuman) resolveNight(room);
    }
  }, 2500);
}

io.on('connection', (socket) => {
  console.log('connected', socket.id);

  socket.on('create', ({ name }) => {
    const room = createRoom(socket.id, name || 'Host');
    socket.join(room.code);
    socket.emit('joined', { code: room.code, isHost: true });
    broadcastRoom(room);
  });

  socket.on('join', ({ code, name }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return socket.emit('error', 'Stanza non trovata');
    if (room.phase !== 'lobby') return socket.emit('error', 'Partita già iniziata');
    if (room.players.filter(p => !p.isBot).length >= 3) return socket.emit('error', 'Stanza piena (max 3 umani)');

    room.players.push({
      id: socket.id,
      name: name || 'Studente',
      role: null,
      alive: true,
      isBot: false,
      isHost: false,
      connected: true
    });
    socket.join(room.code);
    socket.emit('joined', { code: room.code, isHost: false });
    broadcastRoom(room);
  });

  socket.on('start', () => {
    const room = Object.values(rooms).find(r => r.hostId === socket.id);
    if (!room || room.phase !== 'lobby') return;

    // Assicurati di avere 3 umani, altrimenti riempi con bot extra? No, forziamo 5 bot
    addBots(room);
    // Se ci sono meno di 3 umani, i posti mancanti restano bot (già gestito)
    while (room.players.length < 8) {
      room.players.push({
        id: 'bot_' + Math.random().toString(36).slice(2, 9),
        name: BOT_NAMES[room.players.filter(p => p.isBot).length] || 'Bot',
        role: null, alive: true, isBot: true, isHost: false, connected: true
      });
    }

    assignRoles(room);
    room.phase = 'night';
    room.log.unshift('Ruoli assegnati. La notte cala su Valle Giulia…');
    broadcastRoom(room);
  });

  socket.on('nightAction', ({ type, targetId }) => {
    const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
    if (!room || room.phase !== 'night') return;

    const me = room.players.find(p => p.id === socket.id);
    if (!me || !me.alive) return;

    if (type === 'protect' && me.role === 'assistente') {
      if (targetId === room.lastProtectedId) return socket.emit('error', 'Non puoi proteggere la stessa persona due notti di fila');
      room.nightActions.protect = targetId;
    } else if (type === 'seer' && me.role === 'fuoricorso') {
      room.nightActions.seer = targetId;
      const target = room.players.find(p => p.id === targetId);
      const isWolf = target?.role === 'professore';
      socket.emit('seerResult', { name: target?.name, isWolf });
    } else if (type === 'kill' && me.role === 'professore') {
      room.nightActions.kill = targetId;
    }

    // Controlla se tutte le azioni umane necessarie sono fatte
    const humanGuard = room.players.find(p => p.role === 'assistente' && p.alive && !p.isBot);
    const humanSeer = room.players.find(p => p.role === 'fuoricorso' && p.alive && !p.isBot);
    const humanWolves = aliveWolves(room).filter(p => !p.isBot);

    const guardDone = !humanGuard || room.nightActions.protect !== null;
    const seerDone = !humanSeer || room.nightActions.seer !== null;
    const wolvesDone = humanWolves.length === 0 || room.nightActions.kill !== null;

    if (guardDone && seerDone && wolvesDone) {
      resolveNight(room);
    } else {
      broadcastRoom(room);
    }
  });

  socket.on('vote', ({ targetId }) => {
    const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
    if (!room || room.phase !== 'day') return;
    const me = room.players.find(p => p.id === socket.id);
    if (!me || !me.alive) return;

    room.votes[socket.id] = targetId;

    // Bot votano subito dopo il primo voto umano o quando tutti gli umani hanno votato
    const humansAlive = alive(room).filter(p => !p.isBot);
    const humansVoted = humansAlive.filter(p => room.votes[p.id]).length;

    if (humansVoted >= humansAlive.length) {
      // Fai votare i bot
      alive(room).filter(p => p.isBot).forEach(bot => {
        let pool;
        if (bot.role === 'professore') {
          pool = aliveVillagers(room);
          const humans = pool.filter(p => !p.isBot);
          if (humans.length && Math.random() < 0.65) pool = humans;
        } else {
          pool = alive(room).filter(p => p.id !== bot.id);
        }
        if (pool.length) {
          room.votes[bot.id] = pool[Math.floor(Math.random() * pool.length)].id;
        }
      });
      resolveVotes(room);
    } else {
      broadcastRoom(room);
    }
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const p = room.players.find(pl => pl.id === socket.id);
      if (p) {
        p.connected = false;
        if (room.phase === 'lobby') {
          room.players = room.players.filter(pl => pl.id !== socket.id);
          if (room.players.length === 0) delete rooms[code];
          else broadcastRoom(room);
        } else {
          broadcastRoom(room);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Lupus Valle Giulia running on ${PORT}`));
