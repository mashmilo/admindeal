const DEF = {
  feePercent: 1.5,
  googleClientId: '',
  fbAppId: '',
  methods: [
    { name: 'bKash', number: '01XXXXXXXXX' },
    { name: 'Nagad', number: '01XXXXXXXXX' }
  ],
  // Bot messages are in Bangla. Everything else in the app is English.
  texts: {
    welcome: 'ডিল তৈরি হয়েছে। এই লিংক ক্রেতা ও বিক্রেতাকে পাঠান। দুজন যুক্ত হলে পরের ধাপ শুরু হবে।',
    roles: 'দুজন যুক্ত হয়েছেন। ক্রেতা ও বিক্রেতা বেছে নিন।',
    amount: 'বিক্রেতা, ডিলের পরিমাণ (টাকায়) লিখুন।',
    pay: 'ডিলের পরিমাণ: ৳{amount}\nসার্ভিস ফি ({fee}%): ৳{feeAmt}\nক্রেতাকে মোট পরিশোধ করতে হবে: ৳{total}\n\nক্রেতা, পেমেন্ট মাধ্যম বেছে নিন।',
    payDetail: '{method} নম্বরে ৳{total} পাঠান: {number}\nপাঠানো হলে নিচের বাটনে চাপুন।',
    sent: 'ক্রেতা টাকা পাঠিয়েছেন বলে জানিয়েছেন। অ্যাডমিন যাচাই করছেন।',
    verified: 'অ্যাডমিন পেমেন্ট পেয়েছেন। ক্রেতা, পণ্য/সেবা বুঝে পেলে নিচের বাটনে চাপুন।',
    notPaid: 'এখনো পেমেন্ট পাওয়া যায়নি। ক্রেতা, আবার পাঠিয়ে "টাকা পাঠিয়েছি" চাপুন।',
    received: 'ক্রেতা পণ্য/সেবা পাওয়ার কথা নিশ্চিত করেছেন। অ্যাডমিন বিক্রেতাকে টাকা পাঠাবেন।',
    done: 'ডিল সম্পন্ন হয়েছে। ধন্যবাদ।',
    cancelled: 'ডিলটি বাতিল করা হয়েছে। অ্যাডমিন বিস্তারিত জানাবেন।'
  }
};

const MANUAL = ['verify', 'deliver', 'release', 'done'];
const ENDED = ['done', 'cancelled'];
const SESSION_TTL = 60 * 60 * 24 * 30;

const J = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json;charset=utf-8' } });

const fill = (t, v) => String(t).replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? ''));

export async function onRequest({ request, env, params }) {
  try {
    const path = (params.path || []).join('/');
    const m = request.method;
    const body = m === 'POST' ? await request.json().catch(() => ({})) : {};
    const isAdmin = request.headers.get('x-admin-key') === env.ADMIN_PASSWORD;
    const memberHdr = request.headers.get('x-member') || '';
    const bearer = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
    const err = t => J({ error: t }, 400);

    const getS = async () => {
      const s = (await env.DB.get('settings', 'json')) || {};
      return {
        feePercent: s.feePercent ?? DEF.feePercent,
        googleClientId: s.googleClientId ?? DEF.googleClientId,
        fbAppId: s.fbAppId ?? DEF.fbAppId,
        methods: s.methods || DEF.methods,
        texts: { ...DEF.texts, ...(s.texts || {}) }
      };
    };
    const getRoom = id => env.DB.get('room:' + id, 'json');
    const saveRoom = r => env.DB.put('room:' + r.id, JSON.stringify(r));
    const push = (r, who, text) => r.messages.push({ who, text, t: Date.now() });
    const botMsg = (r, s, key, vars = {}) => push(r, 'bot', fill(s.texts[key], vars));
    const notify = async text => {
      const n = (await env.DB.get('notifs', 'json')) || [];
      n.unshift({ text, t: Date.now(), read: false });
      await env.DB.put('notifs', JSON.stringify(n.slice(0, 300)));
    };
    const getUser = async () => {
      if (!bearer) return null;
      const ss = await env.DB.get('session:' + bearer, 'json');
      return ss ? env.DB.get('user:' + ss.uid, 'json') : null;
    };
    const addUserRoom = async (uid, roomId) => {
      const l = (await env.DB.get('urooms:' + uid, 'json')) || [];
      if (!l.includes(roomId)) {
        l.unshift(roomId);
        await env.DB.put('urooms:' + uid, JSON.stringify(l.slice(0, 300)));
      }
    };
    const statsFor = async uid => {
      const ids = (await env.DB.get('urooms:' + uid, 'json')) || [];
      const deals = [];
      let done = 0, cancelled = 0, active = 0;
      for (const id of ids) {
        const r = await getRoom(id);
        if (!r) continue;
        const me = r.members.find(x => x.uid === uid);
        if (!me) continue;
        const status = r.status || 'active';
        if (status === 'done') done++;
        else if (status === 'cancelled') cancelled++;
        else active++;
        deals.push({ id: r.id, role: me.role, amount: r.amount, fee: r.fee, total: r.total, status, t: r.t });
      }
      const finished = done + cancelled;
      const reports = (await env.DB.get('reports', 'json')) || [];
      const scamReports = reports.filter(x => x.against === uid && x.status === 'valid').length;
      return {
        totalDeals: ids.length, done, cancelled, active, scamReports,
        rate: finished ? Math.round((done / finished) * 100) : null,
        deals
      };
    };
    const publicRoom = (r, memberId) => {
      const me = memberId ? r.members.find(x => x.id === memberId) : null;
      return {
        id: r.id, step: r.step, status: r.status || 'active',
        amount: r.amount, fee: r.fee, total: r.total,
        method: r.method ? { name: r.method.name, number: r.method.number } : null,
        messages: r.messages,
        members: r.members.map(x => ({ role: x.role, uid: x.uid || null })),
        mine: { isMember: !!me, role: me ? me.role : null },
        t: r.t
      };
    };
    const loginUser = async (uid, name, picture) => {
      const user = { uid, name: String(name || 'User').slice(0, 60), picture: picture || '', t: Date.now() };
      await env.DB.put('user:' + uid, JSON.stringify(user));
      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
      await env.DB.put('session:' + token, JSON.stringify({ uid }), { expirationTtl: SESSION_TTL });
      return J({ token, user });
    };

    // ---------- Public ----------
    if (path === 'settings' && m === 'GET') return J(await getS());

    if (path === 'auth/google' && m === 'POST') {
      const s = await getS();
      if (!s.googleClientId) return err('Google login is not configured');
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(body.credential || ''));
      const t = await r.json().catch(() => ({}));
      if (!r.ok || t.aud !== s.googleClientId) return J({ error: 'Google login failed' }, 401);
      return loginUser('google_' + t.sub, t.name, t.picture);
    }

    if (path === 'auth/facebook' && m === 'POST') {
      const s = await getS();
      if (!s.fbAppId) return err('Facebook login is not configured');
      const r = await fetch('https://graph.facebook.com/me?fields=id,name,picture.width(200).height(200)&access_token=' + encodeURIComponent(body.accessToken || ''));
      const t = await r.json().catch(() => ({}));
      if (!r.ok || !t.id) return J({ error: 'Facebook login failed' }, 401);
      return loginUser('facebook_' + t.id, t.name, t.picture?.data?.url || '');
    }

    if (path === 'me' && m === 'GET') {
      const u = await getUser();
      if (!u) return J({ error: 'Not logged in' }, 401);
      return J({ user: u, stats: await statsFor(u.uid) });
    }

    const pf = path.match(/^profile\/([\w-]+)$/);
    if (pf && m === 'GET') {
      const u = await env.DB.get('user:' + pf[1], 'json');
      if (!u) return J({ error: 'Profile not found' }, 404);
      const st = await statsFor(u.uid);
      const { deals, ...pub } = st;
      return J({ user: { uid: u.uid, name: u.name, picture: u.picture }, stats: pub });
    }

    if (path === 'room' && m === 'POST') {
      const s = await getS();
      const id = crypto.randomUUID().slice(0, 8);
      const r = { id, step: 'join', status: 'active', members: [], amount: 0, fee: 0, total: 0, method: null, messages: [], t: Date.now() };
      botMsg(r, s, 'welcome');
      await saveRoom(r);
      const idx = (await env.DB.get('index', 'json')) || [];
      idx.unshift(id);
      await env.DB.put('index', JSON.stringify(idx.slice(0, 500)));
      return J({ id });
    }

    const rm = path.match(/^room\/([\w-]+)(?:\/(\w+))?$/);
    if (rm) {
      const [, id, sub] = rm;
      const r = await getRoom(id);
      if (!r) return J({ error: 'Deal not found' }, 404);
      if (!sub && m === 'GET') return J(publicRoom(r, memberHdr));

      const s = await getS();

      if (sub === 'join' && m === 'POST') {
        if (r.members.length >= 2) return err('This deal already has 2 members');
        const u = await getUser();
        if (u && r.members.some(x => x.uid === u.uid)) return err('You are already in this deal');
        const member = { id: crypto.randomUUID().slice(0, 8), role: null, uid: u ? u.uid : null };
        r.members.push(member);
        push(r, 'sys', 'A member joined');
        if (r.members.length === 2) {
          r.step = 'roles';
          botMsg(r, s, 'roles');
        }
        if (u) await addUserRoom(u.uid, r.id);
        await saveRoom(r);
        return J({ memberId: member.id, room: publicRoom(r, member.id) });
      }

      if (sub === 'action' && m === 'POST') {
        const mem = r.members.find(x => x.id === body.memberId);
        if (!mem) return J({ error: 'You are not a member of this deal' }, 403);
        if (ENDED.includes(r.status)) return err('This deal has ended');
        const act = body.action, v = body.value;

        if (act === 'role') {
          if (r.step !== 'roles') return err('Role selection is not active');
          if (mem.role) return err('Your role is already set');
          if (v !== 'buyer' && v !== 'seller') return err('Invalid role');
          if (r.members.some(x => x.role === v)) return err('That role is already taken');
          mem.role = v;
          push(r, 'sys', (v === 'buyer' ? 'Buyer' : 'Seller') + ' role set');
          if (r.members.every(x => x.role)) {
            r.step = 'amount';
            botMsg(r, s, 'amount');
          }
        }
        else if (act === 'amount') {
          if (r.step !== 'amount' || mem.role !== 'seller') return err('Only the seller can set the amount');
          const amt = Number(v);
          if (!(amt > 0)) return err('Enter a valid amount');
          r.amount = amt;
          r.fee = Math.round(amt * s.feePercent) / 100;
          r.total = Math.round((amt + r.fee) * 100) / 100;
          r.step = 'pay';
          botMsg(r, s, 'pay', { amount: amt, fee: s.feePercent, feeAmt: r.fee, total: r.total });
          await notify(`Deal #${r.id}: amount ৳${amt} set.`);
        }
        else if (act === 'method') {
          if (r.step !== 'pay' || mem.role !== 'buyer') return err('Only the buyer can choose a method');
          const meth = s.methods[Number(v)];
          if (!meth) return err('Invalid payment method');
          r.method = meth;
          botMsg(r, s, 'payDetail', { total: r.total, method: meth.name, number: meth.number });
        }
        else if (act === 'sent') {
          if (r.step !== 'pay' || mem.role !== 'buyer' || !r.method) return err('Not allowed now');
          r.step = 'verify';
          botMsg(r, s, 'sent');
          await notify(`💰 Deal #${r.id}: buyer says payment sent (৳${r.total}). Please verify.`);
        }
        else if (act === 'received') {
          if (r.step !== 'deliver' || mem.role !== 'buyer') return err('Not allowed now');
          r.step = 'release';
          botMsg(r, s, 'received');
          await notify(`🔔 Deal #${r.id}: buyer confirmed delivery. Release payment to seller.`);
        }
        else return err('Invalid action');

        await saveRoom(r);
        return J(publicRoom(r, mem.id));
      }

      if (sub === 'msg' && m === 'POST') {
        const mem = r.members.find(x => x.id === body.memberId);
        if (!mem || !mem.role) return J({ error: 'You are not a member of this deal' }, 403);
        if (ENDED.includes(r.status)) return err('This deal has ended');
        if (!MANUAL.includes(r.step)) return err('Chat opens after the bot step is complete');
        const t = String(body.text || '').trim().slice(0, 1000);
        if (!t) return err('Write a message');
        push(r, mem.role, t);
        await saveRoom(r);
        return J(publicRoom(r, mem.id));
      }

      if (sub === 'report' && m === 'POST') {
        const mem = r.members.find(x => x.id === body.memberId);
        if (!mem) return J({ error: 'You are not a member of this deal' }, 403);
        const other = r.members.find(x => x !== mem);
        if (!other || !other.uid) return err('Only logged-in users can be reported');
        const reason = String(body.reason || '').trim().slice(0, 300);
        if (!reason) return err('Write a reason');
        const reports = (await env.DB.get('reports', 'json')) || [];
        if (mem.uid && reports.some(x => x.roomId === r.id && x.by === mem.uid)) return err('You already reported in this deal');
        reports.unshift({
          id: crypto.randomUUID().slice(0, 8), roomId: r.id, against: other.uid,
          by: mem.uid || 'guest', reason, status: 'open', t: Date.now()
        });
        await env.DB.put('reports', JSON.stringify(reports.slice(0, 1000)));
        await notify(`⚠️ Scam report on deal #${r.id}. Review in Reports.`);
        return J({ ok: true });
      }
    }

    // ---------- Admin ----------
    const am = path.match(/^admin\/(.+)$/);
    if (am) {
      if (!isAdmin) return J({ error: 'Unauthorized' }, 401);
      const p = am[1];

      if (p === 'login') return J({ ok: true });

      if (p === 'settings' && m === 'POST') {
        const cur = (await env.DB.get('settings', 'json')) || {};
        if ('feePercent' in body) cur.feePercent = Math.max(0, Number(body.feePercent) || 0);
        if ('googleClientId' in body) cur.googleClientId = String(body.googleClientId || '').trim().slice(0, 200);
        if ('fbAppId' in body) cur.fbAppId = String(body.fbAppId || '').trim().slice(0, 50);
        if (Array.isArray(body.methods)) {
          cur.methods = body.methods
            .map(x => ({ name: String(x.name || '').trim().slice(0, 30), number: String(x.number || '').trim().slice(0, 30) }))
            .filter(x => x.name && x.number);
        }
        if (body.texts && typeof body.texts === 'object') {
          cur.texts = { ...(cur.texts || {}) };
          for (const k of Object.keys(DEF.texts)) if (typeof body.texts[k] === 'string') cur.texts[k] = body.texts[k].slice(0, 1000);
        }
        await env.DB.put('settings', JSON.stringify(cur));
        return J(await getS());
      }

      if (p === 'rooms') {
        const idx = (await env.DB.get('index', 'json')) || [];
        const rooms = [];
        for (const id of idx.slice(0, 100)) { const r = await getRoom(id); if (r) rooms.push(r); }
        return J(rooms);
      }

      if (p === 'reports') return J((await env.DB.get('reports', 'json')) || []);

      const rp = p.match(/^reports\/([\w-]+)\/action$/);
      if (rp && m === 'POST') {
        const reports = (await env.DB.get('reports', 'json')) || [];
        const rep = reports.find(x => x.id === rp[1]);
        if (!rep) return J({ error: 'Report not found' }, 404);
        if (body.action === 'valid') rep.status = 'valid';
        else if (body.action === 'dismiss') rep.status = 'dismissed';
        else return err('Invalid action');
        await env.DB.put('reports', JSON.stringify(reports));
        return J({ ok: true });
      }

      if (p === 'notifs') return J((await env.DB.get('notifs', 'json')) || []);

      if (p === 'notifs/read' && m === 'POST') {
        const n = (await env.DB.get('notifs', 'json')) || [];
        n.forEach(x => (x.read = true));
        await env.DB.put('notifs', JSON.stringify(n));
        return J({ ok: true });
      }

      const ra = p.match(/^room\/([\w-]+)\/action$/);
      if (ra && m === 'POST') {
        const r = await getRoom(ra[1]);
        if (!r) return J({ error: 'Deal not found' }, 404);
        const s = await getS();
        const a = body.action;

        if (a === 'msg') {
          const t = String(body.text || '').trim().slice(0, 1000);
          if (!t) return err('Write a message');
          push(r, 'admin', t);
        }
        else if (a === 'confirm' && r.step === 'verify') {
          r.step = 'deliver';
          botMsg(r, s, 'verified');
        }
        else if (a === 'reject' && r.step === 'verify') {
          r.step = 'pay';
          r.method = null;
          botMsg(r, s, 'notPaid');
        }
        else if (a === 'released' && r.step === 'release') {
          r.step = 'done';
          r.status = 'done';
          botMsg(r, s, 'done');
        }
        else if (a === 'cancel' && !ENDED.includes(r.status)) {
          r.status = 'cancelled';
          botMsg(r, s, 'cancelled');
        }
        else return err('This action is not allowed at this step');

        await saveRoom(r);
        return J(r);
      }
      return J({ error: 'Not found' }, 404);
    }

    return J({ error: 'Not found' }, 404);
  } catch (e) {
    return J({ error: 'Server error: ' + e.message }, 500);
  }
}
