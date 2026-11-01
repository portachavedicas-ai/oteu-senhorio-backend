const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');

const app = express();

app.use(cors({
  origin: [
    'https://portachavedicas-ai.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    /\.github\.io$/
  ],
  credentials: true
}));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage() });

// ── AUTH ────────────────────────────────────────────────────────
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

// ── LEADS ───────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  const { data, error } = await supabase
    .from('ts_leads')
    .select('*, ts_notes(*), ts_media(*)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/leads', async (req, res) => {
  const { data, error } = await supabase
    .from('ts_leads')
    .insert([{ ...req.body, is_new: true }])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.patch('/api/leads/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('ts_leads')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/leads/:id', async (req, res) => {
  const { error } = await supabase
    .from('ts_leads')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

// ── NOTES ───────────────────────────────────────────────────────
app.post('/api/leads/:id/notes', async (req, res) => {
  const { data, error } = await supabase
    .from('ts_notes')
    .insert([{ lead_id: req.params.id, ...req.body }])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ── MEDIA ───────────────────────────────────────────────────────
app.post('/api/leads/:id/media', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Ficheiro em falta' });
  try {
    const isVideo = req.file.mimetype.startsWith('video/');
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: isVideo ? 'video' : 'image', folder: 'oteu-senhorio' },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(req.file.buffer);
    });
    const { data, error } = await supabase
      .from('ts_media')
      .insert([{
        lead_id: req.params.id,
        url: result.secure_url,
        tipo: isVideo ? 'video' : 'imagem',
        nome: req.file.originalname
      }])
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WEBHOOKS ────────────────────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;
  const tel = msg.from;
  const nome = msg.from;
  await supabase.from('ts_leads').insert([{ nome, tel, fonte: 'WhatsApp', etapa: 'Lead', is_new: true }]);
});

app.get('/webhook/whatsapp', (req, res) => {
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (token === process.env.META_VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

app.post('/webhook/meta-leads', async (req, res) => {
  res.sendStatus(200);
  const entry = req.body?.entry?.[0]?.changes?.[0]?.value?.leads?.[0];
  if (!entry) return;
  const fields = {};
  (entry.field_data || []).forEach(f => { fields[f.name] = f.values?.[0]; });
  await supabase.from('ts_leads').insert([{
    nome: fields.full_name || fields.name || 'Lead Meta',
    email: fields.email,
    tel: fields.phone_number,
    fonte: 'Instagram',
    etapa: 'Lead',
    is_new: true
  }]);
});

app.get('/webhook/meta-leads', (req, res) => {
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (token === process.env.META_VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

// ── HEALTH ──────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', cloudinary: process.env.CLOUDINARY_CLOUD_NAME || 'not set' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
