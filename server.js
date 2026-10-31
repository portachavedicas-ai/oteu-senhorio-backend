require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Supabase Client ───────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Cloudinary Config ─────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Multer (memory storage for Cloudinary upload) ─────────────────────────────
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/', 'video/'];
    if (allowed.some(t => file.mimetype.startsWith(t))) cb(null, true);
    else cb(new Error('Apenas imagens e vídeos são permitidos'), false);
  }
});

// ─── Health Check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'O Teu Senhorio Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LEADS API
// ═══════════════════════════════════════════════════════════════════════════════

// GET all leads
app.get('/api/leads', async (req, res) => {
  const { data, error } = await supabase
    .from('ts_leads')
    .select('*, ts_notes(*), ts_calls(*), ts_media(*)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// POST create lead (manual or from webhook)
app.post('/api/leads', async (req, res) => {
  const lead = {
    nome: req.body.nome || 'Sem Nome',
    tel: req.body.tel || null,
    email: req.body.email || null,
    imovel: req.body.imovel || null,
    fonte: req.body.fonte || 'Manual',
    etapa: req.body.etapa || 'Lead',
    resp: req.body.resp || null,
    invest: req.body.invest || null,
    data: req.body.data || new Date().toISOString().split('T')[0],
    is_new: true,
  };
  const { data, error } = await supabase.from('ts_leads').insert([lead]).select().single();
  if (error) return res.status(500).json({ error });
  res.status(201).json(data);
});

// PATCH update lead
app.patch('/api/leads/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('ts_leads')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// DELETE lead
app.delete('/api/leads/:id', async (req, res) => {
  const { error } = await supabase.from('ts_leads').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error });
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CALLS API
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/leads/:id/calls', async (req, res) => {
  const call = { lead_id: req.params.id, ...req.body };
  const { data, error } = await supabase.from('ts_calls').insert([call]).select().single();
  if (error) return res.status(500).json({ error });

  // Mark lead as not new after first call
  if (req.body.secs_to_contact) {
    await supabase.from('ts_leads')
      .update({ is_new: false, secs_to_contact: req.body.secs_to_contact })
      .eq('id', req.params.id);
  }
  res.status(201).json(data);
});

// ═══════════════════════════════════════════════════════════════════════════════
// NOTES API
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/leads/:id/notes', async (req, res) => {
  const note = { lead_id: req.params.id, ...req.body };
  const { data, error } = await supabase.from('ts_notes').insert([note]).select().single();
  if (error) return res.status(500).json({ error });
  res.status(201).json(data);
});

// ═══════════════════════════════════════════════════════════════════════════════
// MEDIA UPLOAD (Cloudinary)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/leads/:id/media', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum ficheiro enviado' });

  const leadId = req.params.id;
  const isVideo = req.file.mimetype.startsWith('video/');

  try {
    // Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: isVideo ? 'video' : 'image',
          folder: `oteu-senhorio/leads/${leadId}`,
          transformation: isVideo ? [] : [{ quality: 'auto', fetch_format: 'auto' }]
        },
        (err, res) => err ? reject(err) : resolve(res)
      );
      uploadStream.end(req.file.buffer);
    });

    // Save to Supabase
    const media = {
      lead_id: leadId,
      url: result.secure_url,
      public_id: result.public_id,
      tipo: isVideo ? 'video' : 'foto',
      nome: req.file.originalname,
    };
    const { data, error } = await supabase.from('ts_media').insert([media]).select().single();
    if (error) return res.status(500).json({ error });
    res.status(201).json(data);
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOKS — WhatsApp Business API
// ═══════════════════════════════════════════════════════════════════════════════

// Webhook verification (GET)
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('WhatsApp webhook verified!');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Webhook events (POST)
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200); // Always respond 200 immediately

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.messages) continue;

        for (const message of value.messages) {
          if (message.type !== 'text') continue;

          const phone = message.from; // e.g. "351912345678"
          const text = message.text?.body || '';
          const contact = value.contacts?.[0];
          const nome = contact?.profile?.name || phone;

          // Check if lead already exists
          const { data: existing } = await supabase
            .from('ts_leads')
            .select('id')
            .eq('tel', phone)
            .single();

          if (!existing) {
            // Create new lead from WhatsApp
            await supabase.from('ts_leads').insert([{
              nome,
              tel: phone,
              fonte: 'WhatsApp',
              etapa: 'Lead',
              is_new: true,
              data: new Date().toISOString().split('T')[0],
            }]);
            console.log(`Nova lead WhatsApp: ${nome} (${phone})`);
          }
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOKS — Meta Lead Ads (Instagram/Facebook)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/webhook/meta-leads', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('Meta Leads webhook verified!');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook/meta-leads', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'leadgen') continue;

        const leadgenId = change.value.leadgen_id;
        const pageId = change.value.page_id;

        // Fetch lead details from Meta API
        const leadRes = await fetch(
          `https://graph.facebook.com/v19.0/${leadgenId}?access_token=${process.env.WHATSAPP_TOKEN}`
        );
        const leadData = await leadRes.json();

        if (!leadData.field_data) continue;

        // Parse field data
        const fields = {};
        for (const field of leadData.field_data) {
          fields[field.name] = field.values?.[0] || '';
        }

        const lead = {
          nome: fields['full_name'] || fields['nome'] || 'Lead Instagram',
          tel: fields['phone_number'] || fields['telefone'] || null,
          email: fields['email'] || null,
          imovel: fields['imovel'] || fields['property'] || null,
          fonte: 'Instagram',
          etapa: 'Lead',
          is_new: true,
          data: new Date().toISOString().split('T')[0],
        };

        await supabase.from('ts_leads').insert([lead]);
        console.log(`Nova lead Instagram/Facebook: ${lead.nome}`);
      }
    }
  } catch (err) {
    console.error('Meta Leads webhook error:', err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOKS — Website Contact Form
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/webhook/site-form', async (req, res) => {
  const { nome, tel, email, imovel, mensagem } = req.body;

  if (!nome && !tel && !email) {
    return res.status(400).json({ error: 'Dados insuficientes' });
  }

  const { data, error } = await supabase.from('ts_leads').insert([{
    nome: nome || 'Sem Nome',
    tel: tel || null,
    email: email || null,
    imovel: imovel || null,
    fonte: 'Site',
    etapa: 'Lead',
    is_new: true,
    data: new Date().toISOString().split('T')[0],
  }]).select().single();

  if (error) return res.status(500).json({ error });

  // Add initial note with message if provided
  if (mensagem && data?.id) {
    await supabase.from('ts_notes').insert([{
      lead_id: data.id,
      txt: `Mensagem do site: ${mensagem}`,
      autor: 'Sistema',
    }]);
  }

  res.status(201).json({ success: true, lead_id: data?.id });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MARKETING METRICS API
// ═══════════════════════════════════════════════════════════════════════════════

// GET marketing metrics
app.get('/api/marketing', async (req, res) => {
  const { data, error } = await supabase
    .from('ts_marketing')
    .select('*')
    .order('data', { ascending: false })
    .limit(90); // Last 90 days
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// POST marketing metrics (called by sync scripts)
app.post('/api/marketing', async (req, res) => {
  const { data, error } = await supabase
    .from('ts_marketing')
    .upsert(req.body, { onConflict: 'canal,data' })
    .select();
  if (error) return res.status(500).json({ error });
  res.status(201).json(data);
});

// ═══════════════════════════════════════════════════════════════════════════════
// USERS API
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/users', async (req, res) => {
  const { data, error } = await supabase
    .from('ts_users')
    .select('id, nome, initials, role, color')
    .order('nome');
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// POST verify PIN login
app.post('/api/auth/login', async (req, res) => {
  const { pin } = req.body;
  const { data, error } = await supabase
    .from('ts_users')
    .select('id, nome, initials, role, color')
    .eq('pin', pin)
    .single();
  if (error || !data) return res.status(401).json({ error: 'PIN inválido' });
  res.json(data);
});

// ─── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ O Teu Senhorio Backend running on port ${PORT}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`   Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME || '(not configured)'}`);
});
