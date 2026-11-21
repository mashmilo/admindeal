const DEF = {
  feePercent: 1.5,
  bkash: '01XXXXXXXXX',
  nagad: '01XXXXXXXXX',
  payText: 'উপরের নম্বরে টাকা পাঠিয়ে "টাকা পাঠিয়েছি" বাটনে ক্লিক করুন।'
};

const J = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json;charset=utf-8' } });

export async function onRequest({ request, env, params }) {
  try {
    const path = (params.path || []).join('/');
    const m = request.method;
    const body = m === 'POST' ? await request.json().catch(() => ({})) : {};
    const admin = request.headers.get('x-admin-key') === env.ADMIN_PASSWORD;

    const err = t => J({ error: t }, 400);
    const settings = async () => ({ ...DEF, ...((await env.DB.get('settings', 'json')) || {}) });
    const getRoom = id => env.DB.get('room:' + id, 'json');
    const saveRoom = r => env.DB.put('room:' + r.id, JSON.stringify(r));
    const bot = (r, text, type = 'bot', from = '🤖 অ্যাডমিন বট') =>
      r.messages.push({ from, text, type, t: Date.now() });
    const notify = async (roomId, text) => {
      const n = (await env.DB.get('notifs', 'json')) || [];
      n.unshift({ text, roomId, t: Date.now(), read: false });
      await env.DB.put('notifs', JSON.stringify(n.slice(0, 300)));
    };

    // ---------- Public ----------
    if (path === 'settings' && m === 'GET') return J(await settings());

    if (path === 'room' && m === 'POST') {
      const id = crypto.randomUUID().slice(0, 8);
      const r = { id, step: 'join', members: [], amount: 0, fee: 0, total: 0, messages: [], t: Date.now() };
      bot(r, 'নতুন ডিল তৈরি হয়েছে। এই লিংক আরও দুইজনকে দিন। দুইজন যুক্ত হলে ভূমিকা বাছাই শুরু হবে।');
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

      if (sub === 'join' && m === 'POST') {
        const name = String(body.name || '').trim().slice(0, 30);
        if (!name) return err('নাম লিখুন');
        if (r.members.length >= 2) return err('এই ডিলে ইতিমধ্যে ২ জন আছেন');
        const member = { id: crypto.randomUUID().slice(0, 8), name, role: null };
        r.members.push(member);
        bot(r, `${name} যুক্ত হয়েছেন।`);
        if (r.members.length === 2) {
          r.step = 'roles';
          bot(r, 'দুজন সদস্য যুক্ত হয়েছেন। এখন বাছাই করুন কে ক্রেতা, কে বিক্রেতা।\nক্রেতা = যিনি টাকা পাঠাবেন। বিক্রেতা = যিনি পণ্য/সেবা দেবেন।');
        }
        await saveRoom(r);
        return J({ member });
      }

      if (sub === 'action' && m === 'POST') {
        const mem = r.members.find(x => x.id === body.memberId);
        if (!mem) return J({ error: 'আপনি এই ডিলের সদস্য নন' }, 403);
        const s = await settings();
        const act = body.action, v = body.value;

        if (act === 'role') {
          if (r.step !== 'roles') return err('এখন ভূমিকা বাছাইয়ের সময় নয়');
          if (mem.role) return err('আপনার ভূমিকা আগেই বাছাই করা হয়েছে');
          if (r.members.some(x => x.role === v)) return err('এই ভূমিকা ইতিমধ্যে নেওয়া হয়েছে');
          mem.role = v;
          bot(r, `${mem.name} হলেন ${v === 'buyer' ? 'ক্রেতা' : 'বিক্রেতা'}।`);
          if (r.members.every(x => x.role)) {
            r.step = 'amount';
            const b = r.members.find(x => x.role === 'buyer');
            bot(r, `ক্রেতা (${b.name}), ডিলের পরিমাণ টাকায় লিখুন।`);
          }
        }
        else if (act === 'amount') {
          if (r.step !== 'amount' || mem.role !== 'buyer') return err('এই কাজটি করার অনুমতি নেই');
          const amt = Number(v);
          if (!(amt > 0)) return err('সঠিক পরিমাণ লিখুন');
          r.amount = amt;
          r.fee = Math.round(amt * s.feePercent) / 100;
          r.total = Math.round((amt + r.fee) * 100) / 100;
          r.step = 'pay';
          bot(r,
            `ডিলের পরিমাণ: ৳${amt}\n` +
            `সার্ভিস ফি (${s.feePercent}%): ৳${r.fee}\n` +
            `ক্রেতাকে মোট পরিশোধ করতে হবে: ৳${r.total}\n\n` +
            `${s.payText}\n\nবিকাশ: ${s.bkash}\nনগদ: ${s.nagad}`);
          await notify(r.id, `ডিল ${r.id}: ক্রেতা ৳${amt} পরিমাণ দিয়েছেন। পেমেন্টের অপেক্ষা।`);
        }
        else if (act === 'sent') {
          if (r.step !== 'pay' || mem.role !== 'buyer') return err('এই কাজটি করার অনুমতি নেই');
          r.step = 'verify';
          bot(r, 'ক্রেতা জানিয়েছেন টাকা পাঠানো হয়েছে। অ্যাডমিন পেমেন্ট যাচাই করছেন।');
          await notify(r.id, `💰 ডিল ${r.id}: ক্রেতা টাকা পাঠানোর কথা জানিয়েছেন (৳${r.total})। যাচাই করুন।`);
        }
        else if (act === 'received') {
          if (r.step !== 'deliver' || mem.role !== 'buyer') return err('এই কাজটি করার অনুমতি নেই');
          r.step = 'release';
          bot(r, 'ক্রেতা পণ্য/সেবা পাওয়ার কথা নিশ্চিত করেছেন। অ্যাডমিন বিক্রেতাকে টাকা পাঠাবেন।');
          await notify(r.id, `🔔 ডিল ${r.id}: ক্রেতা নিশ্চিত করেছেন। বিক্রেতাকে টাকা পাঠান।`);
        }
        else return err('অবৈধ কাজ');

        await saveRoom(r);
        return J(r);
      }
    }

    // ---------- Admin ----------
    const am = path.match(/^admin\/(.+)$/);
    if (am) {
      if (!admin) return J({ error: 'অনুমতি নেই' }, 401);
      const p = am[1];

      if (p === 'login') return J({ ok: true });

      if (p === 'settings' && m === 'POST') {
        const cur = (await env.DB.get('settings', 'json')) || {};
        for (const k of ['feePercent', 'bkash', 'nagad', 'payText']) if (k in body) cur[k] = body[k];
        cur.feePercent = Number(cur.feePercent) || 0;
        await env.DB.put('settings', JSON.stringify(cur));
        return J(await settings());
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
        const a = body.action;

        if (a === 'msg') {
          const t = String(body.text || '').trim();
          if (!t) return err('বার্তা লিখুন');
          r.messages.push({ from: 'অ্যাডমিন', text: t, type: 'admin', t: Date.now() });
        }
        else if (a === 'confirm' && r.step === 'verify') {
          r.step = 'deliver';
          bot(r, '✅ অ্যাডমিন পেমেন্ট পেয়েছেন। ক্রেতা, পণ্য/সেবা পেয়ে থাকলে "পণ্য/সেবা পেয়েছি" বাটনে ক্লিক করুন।');
        }
        else if (a === 'reject' && r.step === 'verify') {
          r.step = 'pay';
          bot(r, '⚠️ এখনো পেমেন্ট পাওয়া যায়নি। ক্রেতা, অনুগ্রহ করে পেমেন্ট করে আবার "টাকা পাঠিয়েছি" চাপুন।');
        }
        else if (a === 'released' && r.step === 'release') {
          r.step = 'done';
          bot(r, '✅ বিক্রেতাকে টাকা পাঠানো হয়েছে। ডিল সম্পন্ন হয়েছে।');
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
