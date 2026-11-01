const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Multer — store in memory, upload to Supabase Storage
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/* ══ AUTH ══════════════════════════════════════════════════════════════════ */
const PINS = { '1234': { id: 1, nome: 'Vitor', role: 'admin' } };

app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  const user = PINS[pin];
  if (!user) return res.status(401).json({ error: 'PIN inválido' });
  res.json({ user });
});

/* ══ LEADS ═════════════════════════════════════════════════════════════════ */
app.get('/api/leads', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    // Also fetch notes and media
    const [notesRes, mediaRes] = await Promise.all([
      supabase.from('lead_notes').select('*').eq('lead_id', req.params.id).order('created_at', { ascending: false }),
      supabase.from('lead_media').select('*').eq('lead_id', req.params.id).order('created_at', { ascending: false }),
    ]);
    res.json({ ...data, ts_notes: notesRes.data || [], ts_media: mediaRes.data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', async (req, res) => {
  try {
    const { nome, tel, email, imovel, fonte, etapa, resp, invest, notas } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const { data, error } = await supabase
      .from('leads')
      .insert([{ nome, tel, email, imovel, fonte: fonte||'Manual', etapa: etapa||'Lead', resp, invest, notas, is_new: true }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/leads/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('leads').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══ NOTAS ═════════════════════════════════════════════════════════════════ */
app.get('/api/leads/:id/notes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('lead_notes')
      .select('*')
      .eq('lead_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads/:id/notes', async (req, res) => {
  try {
    const { txt, autor, tipo } = req.body;
    if (!txt) return res.status(400).json({ error: 'Nota vazia' });
    const { data, error } = await supabase
      .from('lead_notes')
      .insert([{ lead_id: parseInt(req.params.id), txt, autor: autor||'Agente', tipo: tipo||'nota' }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id/notes/:noteId', async (req, res) => {
  try {
    const { error } = await supabase.from('lead_notes').delete().eq('id', req.params.noteId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══ MEDIA (fotos, áudio, docs) ════════════════════════════════════════════ */
app.get('/api/leads/:id/media', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('lead_media')
      .select('*')
      .eq('lead_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads/:id/media', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Ficheiro em falta' });
    const leadId = req.params.id;
    const ext = path.extname(req.file.originalname) || '';
    const filename = `lead_${leadId}_${Date.now()}${ext}`;
    const bucket = 'lead-media';

    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (upErr) throw upErr;

    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(filename);

    const tipo = req.file.mimetype.startsWith('image/') ? 'foto'
               : req.file.mimetype.startsWith('video/') ? 'video'
               : req.file.mimetype.startsWith('audio/') ? 'audio'
               : 'doc';

    const { data, error } = await supabase
      .from('lead_media')
      .insert([{ lead_id: parseInt(leadId), nome: req.file.originalname, url: urlData.publicUrl, tipo, size: req.file.size }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id/media/:mediaId', async (req, res) => {
  try {
    const { error } = await supabase.from('lead_media').delete().eq('id', req.params.mediaId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ══ WEBHOOKS ══════════════════════════════════════════════════════════════ */
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const { Body, From, ProfileName } = req.body;
    const tel = From?.replace('whatsapp:', '') || '';
    const { data: existing } = await supabase.from('leads').select('id').eq('tel', tel).single();
    if (!existing) {
      await supabase.from('leads').insert([{
        nome: ProfileName || tel, tel, fonte: 'WhatsApp',
        etapa: 'Lead', is_new: true,
        notas: `Primeira mensagem: ${Body}`
      }]);
    }
    res.send('<Response></Response>');
  } catch (e) { res.send('<Response></Response>'); }
});

app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

app.post('/webhook/meta-leads', async (req, res) => {
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const leadData = change.value?.leadgen_id ? change.value : null;
        if (!leadData) continue;
        const fields = {};
        (leadData.field_data || []).forEach(f => { fields[f.name] = f.values?.[0]; });
        await supabase.from('leads').insert([{
          nome: fields.full_name || fields.name || 'Lead Meta',
          tel: fields.phone_number || fields.phone || null,
          email: fields.email || null,
          fonte: 'Instagram',
          etapa: 'Lead',
          is_new: true,
          notas: JSON.stringify(fields)
        }]);
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/webhook/meta-leads', (req, res) => {
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) return res.send(challenge);
  res.sendStatus(403);
});

/* ══ HEALTH ════════════════════════════════════════════════════════════════ */
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
