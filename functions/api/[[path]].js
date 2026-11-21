const DEF = {
  feePercent: 1.5,
  methods: [
    { name: 'বিকাশ', number: '01XXXXXXXXX' },
    { name: 'নগদ', number: '01XXXXXXXXX' }
  ],
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
    done: 'ডিল সম্পন্ন হয়েছে। ধন্যবাদ।'
  }
};

const MANUAL = ['verify', 'deliver', 'release', 'done'];

const J = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json;charset=utf-8' } });

const fill = (t, v) => String(t).replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? ''));

export async function onRequest({ request, env, params }) {
  try {
    const path = (params.path || []).join('/');
    const m = request.method;
    const body = m === 'POST' ? await request.json().catch(() => ({})) : {};
    const isAdmin = request.headers.get('x-admin-key') === env.ADMIN_PASSWORD;
    const err = t => J({ error: t }, 400);

    const getS = async () => {
      const s = (await env.DB.get('settings', 'json')) || {};
      return {
        feePercent: s.feePercent ?? DEF.feePercent,
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

    // ---------- Public ----------
    if (path === 'settings' && m === 'GET') return J(await getS());

    if (path === 'room' && m === 'POST') {
      const s = await getS();
      const id = crypto.randomUUID().slice(0, 8);
      const r = { id, step: 'join', members: [], amount: 0, fee: 0, total: 0, method: null, messages: [], t: Date.now() };
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
      if (!r) return J({ error: 'ডিলটি পাওয়া যায়নি' }, 404);
      if (!sub && m === 'GET') return J(r);

      const s = await getS();

      if (sub === 'join' && m === 'POST') {
        if (r.members.length >= 2) return err('এই ডিলে ইতিমধ্যে ২ জন আছেন');
        const member = { id: crypto.randomUUID().slice(0, 8), role: null };
        r.members.push(member);
        push(r, 'sys', 'একজন সদস্য যুক্ত হয়েছেন');
        if (r.members.length === 2) {
          r.step = 'roles';
          botMsg(r, s, 'roles');
        }
        await saveRoom(r);
        return J({ member });
      }

      if (sub === 'action' && m === 'POST') {
        const mem = r.members.find(x => x.id === body.memberId);
        if (!mem) return J({ error: 'আপনি এই ডিলের সদস্য নন' }, 403);
        const act = body.action, v = body.value;

        if (act === 'role') {
          if (r.step !== 'roles') return err('এখন ভূমিকা বাছাইয়ের সময় নয়');
          if (mem.role) return err('আপনার ভূমিকা আগেই ঠিক করা হয়েছে');
          if (v !== 'buyer' && v !== 'seller') return err('অবৈধ ভূমিকা');
          if (r.members.some(x => x.role === v)) return err('এই ভূমিকা ইতিমধ্যে নেওয়া হয়েছে');
          mem.role = v;
          push(r, 'sys', (v === 'buyer' ? 'ক্রেতা' : 'বিক্রেতা') + ' নির্ধারিত হয়েছে');
          if (r.members.every(x => x.role)) {
            r.step = 'amount';
            botMsg(r, s, 'amount');
          }
        }
        else if (act === 'amount') {
          if (r.step !== 'amount' || mem.role !== 'seller') return err('শুধু বিক্রেতা পরিমাণ দিতে পারবেন');
          const amt = Number(v);
          if (!(amt > 0)) return err('সঠিক পরিমাণ লিখুন');
          r.amount = amt;
          r.fee = Math.round(amt * s.feePercent) / 100;
          r.total = Math.round((amt + r.fee) * 100) / 100;
          r.step = 'pay';
          botMsg(r, s, 'pay', { amount: amt, fee: s.feePercent, feeAmt: r.fee, total: r.total });
          await notify(`ডিল ${r.id}: পরিমাণ ৳${amt} নির্ধারিত হয়েছে।`);
        }
        else if (act === 'method') {
          if (r.step !== 'pay' || mem.role !== 'buyer') return err('এই কাজটি করার অনুমতি নেই');
          const meth = s.methods[Number(v)];
          if (!meth) return err('অবৈধ পেমেন্ট মাধ্যম');
          r.method = meth;
          botMsg(r, s, 'payDetail', { total: r.total, method: meth.name, number: meth.number });
        }
        else if (act === 'sent') {
          if (r.step !== 'pay' || mem.role !== 'buyer' || !r.method) return err('এই কাজটি করার অনুমতি নেই');
          r.step = 'verify';
          botMsg(r, s, 'sent');
          await notify(`💰 ডিল ${r.id}: ক্রেতা টাকা পাঠানোর কথা জানিয়েছেন (৳${r.total}). যাচাই করুন।`);
        }
        else if (act === 'received') {
          if (r.step !== 'deliver' || mem.role !== 'buyer') return err('এই কাজটি করার অনুমতি নেই');
          r.step = 'release';
          botMsg(r, s, 'received');
          await notify(`🔔 ডিল ${r.id}: ক্রেতা নিশ্চিত করেছেন। বিক্রেতাকে টাকা পাঠান।`);
        }
        else return err('অবৈধ কাজ');

        await saveRoom(r);
        return J(r);
      }

      if (sub === 'msg' && m === 'POST') {
        const mem = r.members.find(x => x.id === body.memberId);
        if (!mem || !mem.role) return J({ error: 'আপনি এই ডিলের সদস্য নন' }, 403);
        if (!MANUAL.includes(r.step)) return err('বট ধাপ চলছে, এখন বার্তা পাঠানো যাবে না');
        const t = String(body.text || '').trim().slice(0, 1000);
        if (!t) return err('বার্তা লিখুন');
        push(r, mem.role, t);
        await saveRoom(r);
        return J(r);
      }
    }

    // ---------- Admin ----------
    const am = path.match(/^admin\/(.+)$/);
    if (am) {
      if (!isAdmin) return J({ error: 'অনুমতি নেই' }, 401);
      const p = am[1];

      if (p === 'login') return J({ ok: true });

      if (p === 'settings' && m === 'POST') {
        const cur = (await env.DB.get('settings', 'json')) || {};
        if ('feePercent' in body) cur.feePercent = Math.max(0, Number(body.feePercent) || 0);
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
        if (!r) return J({ error: 'ডিল নেই' }, 404);
        const s = await getS();
        const a = body.action;

        if (a === 'msg') {
          const t = String(body.text || '').trim().slice(0, 1000);
          if (!t) return err('বার্তা লিখুন');
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
          botMsg(r, s, 'done');
        }
        else return err('এই ধাপে এই কাজ করা যাবে না');

        await saveRoom(r);
        return J(r);
      }
      return J({ error: 'না পাওয়া গেছে' }, 404);
    }

    return J({ error: 'না পাওয়া গেছে' }, 404);
  } catch (e) {
    return J({ error: 'সার্ভার সমস্যা: ' + e.message }, 500);
  }
}
