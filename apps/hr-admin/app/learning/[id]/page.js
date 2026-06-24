'use client';

// Learning ▸ Course builder (Feature 37). The 3-pane authoring surface:
//   left   — module/lesson outline tree (+ Module / + Lesson)
//   center — lesson editor (VIDEO/DOCUMENT/LINK/SCORM content + QUIZ question builder)
//   right  — course settings + the Assign panel (audience + mandatory + due + recurrence)
// Publish runs the server gate (≥1 lesson; every QUIZ lesson has a question with a marked
// correct answer). All writes gated on canManageLearning (server is the real boundary).

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { get, post, put, del } from '@/lib/api';
import { StatusBadge } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import { InfoTip, FieldLabel } from '@/lib/widgets';
import { ErrorBanner, PrimaryButton, TextInput, TextArea, Modal, ModalActions } from '@hr/ui';

const LESSON_KINDS = ['VIDEO', 'DOCUMENT', 'LINK', 'QUIZ', 'SCORM'];
const SCOPES = ['ALL', 'ENTITY', 'DEPARTMENT', 'ROLE', 'SPECIFIC'];
const RECURRENCE = ['NONE', 'ANNUAL', 'HALF_YEARLY', 'QUARTERLY'];

export default function CourseBuilderPage() {
  const { id } = useParams();
  const router = useRouter();
  const [perms, setPerms] = useState(null);
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedLessonId, setSelectedLessonId] = useState(null);
  const [tab, setTab] = useState('build'); // build | settings | assign

  const canManage = hasPermission(perms, 'canManageLearning');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await get('/api/auth/me').catch(() => null);
      setPerms(permissionsFromSession(me?.user || me));
      const c = await get(`/api/hr/learning/courses/${id}`);
      setCourse(c);
      setError('');
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to load course.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  function allLessons(c) {
    const out = [];
    for (const m of (c?.modules || [])) for (const l of (m.lessons || [])) out.push({ ...l, moduleTitle: m.title });
    return out;
  }
  const selectedLesson = course ? allLessons(course).find((l) => l.id === selectedLessonId) : null;

  async function addModule() {
    const title = prompt('Module title');
    if (!title) return;
    try { await post(`/api/hr/learning/courses/${id}/modules`, { title }); await load(); }
    catch (e) { setError(e.data?.message || e.message); }
  }
  async function addLesson(moduleId) {
    const title = prompt('Lesson title');
    if (!title) return;
    const kind = (prompt(`Lesson kind: ${LESSON_KINDS.join(' / ')}`, 'VIDEO') || '').toUpperCase();
    if (!LESSON_KINDS.includes(kind)) { setError('Invalid lesson kind.'); return; }
    try {
      const lesson = await post(`/api/hr/learning/modules/${moduleId}/lessons`, { title, kind });
      if (kind === 'QUIZ') await post(`/api/hr/learning/lessons/${lesson.id}/quiz`, {});
      await load();
      setSelectedLessonId(lesson.id);
    } catch (e) { setError(e.data?.message || e.message); }
  }
  async function removeLesson(lessonId) {
    if (!confirm('Delete this lesson?')) return;
    try { await del(`/api/hr/learning/lessons/${lessonId}`); if (selectedLessonId === lessonId) setSelectedLessonId(null); await load(); }
    catch (e) { setError(e.data?.message || e.message); }
  }
  async function removeModule(moduleId) {
    if (!confirm('Delete this module and its lessons?')) return;
    try { await del(`/api/hr/learning/modules/${moduleId}`); await load(); }
    catch (e) { setError(e.data?.message || e.message); }
  }
  async function publish() {
    setError('');
    try { await post(`/api/hr/learning/courses/${id}/publish`, {}); await load(); }
    catch (e) {
      const errs = e.data?.errors;
      setError(errs && errs.length ? `Cannot publish: ${errs.join(' ')}` : (e.data?.message || e.message));
    }
  }
  async function archive() {
    if (!confirm('Archive this course? It will be hidden from new assignments.')) return;
    try { await post(`/api/hr/learning/courses/${id}/archive`, {}); await load(); }
    catch (e) { setError(e.data?.message || e.message); }
  }

  if (loading) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  if (!course) return <div className="p-6"><ErrorBanner message={error || 'Course not found'} /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button className="text-sm text-gray-500 hover:underline" onClick={() => router.push('/learning')}>← Courses</button>
        <h1 className="text-xl font-semibold text-gray-900">{course.title}</h1>
        <StatusBadge status={course.status} />
        <span className="text-sm text-gray-400">{course.code}</span>
        <div className="ml-auto flex gap-2">
          {canManage && course.status === 'DRAFT' ? <PrimaryButton onClick={publish}>Publish</PrimaryButton> : null}
          {canManage && course.status === 'PUBLISHED' ? <button className="rounded-md border border-gray-300 px-3 py-1.5 text-sm" onClick={archive}>Archive</button> : null}
        </div>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="flex gap-1 border-b border-gray-200">
        {[['build', 'Curriculum'], ['settings', 'Settings'], ['assign', 'Assign']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${tab === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500'}`}>{label}</button>
        ))}
      </div>

      {tab === 'build' ? (
        <div className="grid grid-cols-12 gap-4">
          {/* Left — outline tree */}
          <div className="col-span-4 rounded-lg border border-gray-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-700">Outline</span>
              {canManage ? <button className="text-xs text-blue-600 hover:underline" onClick={addModule}>+ Module</button> : null}
            </div>
            {(course.modules || []).length === 0 ? <p className="text-xs text-gray-400">No modules yet.</p> : null}
            <ul className="space-y-3">
              {(course.modules || []).map((m) => (
                <li key={m.id}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-800">{m.title}</span>
                    {canManage ? (
                      <span className="flex gap-2 text-xs">
                        <button className="text-blue-600 hover:underline" onClick={() => addLesson(m.id)}>+ Lesson</button>
                        <button className="text-red-500 hover:underline" onClick={() => removeModule(m.id)}>×</button>
                      </span>
                    ) : null}
                  </div>
                  <ul className="ml-2 mt-1 space-y-1">
                    {(m.lessons || []).map((l) => (
                      <li key={l.id}>
                        <button onClick={() => setSelectedLessonId(l.id)} className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm ${selectedLessonId === l.id ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-50'}`}>
                          <span>{l.title}</span>
                          <span className="text-[10px] uppercase text-gray-400">{l.kind}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>

          {/* Center — lesson editor */}
          <div className="col-span-8 rounded-lg border border-gray-200 bg-white p-4">
            {selectedLesson
              ? <LessonEditor key={selectedLesson.id} lesson={selectedLesson} canManage={canManage} onChange={load} onDelete={() => removeLesson(selectedLesson.id)} setError={setError} />
              : <p className="text-sm text-gray-400">Select a lesson to edit, or add a module + lesson to start.</p>}
          </div>
        </div>
      ) : null}

      {tab === 'settings' ? <CourseSettings course={course} canManage={canManage} onChange={load} setError={setError} /> : null}
      {tab === 'assign' ? <AssignPanel courseId={id} published={course.status === 'PUBLISHED'} canManage={canManage} setError={setError} /> : null}
    </div>
  );
}

// ── Lesson editor (content + quiz) ──────────────────────────────────────────────
function LessonEditor({ lesson, canManage, onChange, onDelete, setError }) {
  const [draft, setDraft] = useState({
    title: lesson.title, contentUrl: lesson.contentUrl || '', contentText: lesson.contentText || '',
    minWatchPct: lesson.minWatchPct ?? 90, isRequired: lesson.isRequired !== false,
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try { await put(`/api/hr/learning/lessons/${lesson.id}`, draft); await onChange(); }
    catch (e) { setError(e.data?.message || e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">{lesson.kind} lesson</h3>
        {canManage ? <button className="text-xs text-red-500 hover:underline" onClick={onDelete}>Delete lesson</button> : null}
      </div>
      <TextInput label="Title" value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} />

      {lesson.kind === 'VIDEO' ? (
        <>
          <TextInput label="Video URL" value={draft.contentUrl} onChange={(v) => setDraft({ ...draft, contentUrl: v })} hint="Paste an MP4 / streaming URL. Uploads use the media store seam." />
          <TextInput label="Min watch %" type="number" value={String(draft.minWatchPct)} onChange={(v) => setDraft({ ...draft, minWatchPct: Number(v) })} hint="The lesson auto-completes once the learner watches this much." />
        </>
      ) : null}
      {lesson.kind === 'DOCUMENT' ? (
        <>
          <TextInput label="Document URL (PDF)" value={draft.contentUrl} onChange={(v) => setDraft({ ...draft, contentUrl: v })} />
          <TextArea label="…or inline content (markdown)" value={draft.contentText} onChange={(v) => setDraft({ ...draft, contentText: v })} rows={5} />
        </>
      ) : null}
      {(lesson.kind === 'LINK' || lesson.kind === 'SCORM') ? (
        <TextInput label="External URL" value={draft.contentUrl} onChange={(v) => setDraft({ ...draft, contentUrl: v })} hint="The learner opens this and acknowledges completion." />
      ) : null}

      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={draft.isRequired} onChange={(e) => setDraft({ ...draft, isRequired: e.target.checked })} />
        Required for completion
        <InfoTip text="Optional lessons don't gate completion or the certificate." label="Required" />
      </label>

      {canManage ? <PrimaryButton onClick={save} loading={saving}>Save lesson</PrimaryButton> : null}

      {lesson.kind === 'QUIZ' ? <QuizBuilder lesson={lesson} canManage={canManage} onChange={onChange} setError={setError} /> : null}
    </div>
  );
}

// ── Quiz builder ────────────────────────────────────────────────────────────────
function QuizBuilder({ lesson, canManage, onChange, setError }) {
  const quiz = lesson.quiz;
  const [q, setQ] = useState({ prompt: '', kind: 'SINGLE', options: [{ id: 'a', text: '' }, { id: 'b', text: '' }], correct: [] });
  const [saving, setSaving] = useState(false);

  if (!quiz) return <p className="mt-4 text-sm text-gray-400">Saving the quiz…</p>;

  function toggleCorrect(optId) {
    if (q.kind === 'MULTI') setQ({ ...q, correct: q.correct.includes(optId) ? q.correct.filter((x) => x !== optId) : [...q.correct, optId] });
    else setQ({ ...q, correct: [optId] });
  }
  async function addQuestion() {
    if (!q.prompt.trim()) { setError('Question prompt is required.'); return; }
    if (q.correct.length < 1) { setError('Mark at least one correct option.'); return; }
    setSaving(true);
    try {
      await post(`/api/hr/learning/quiz/${quiz.id}/questions`, {
        prompt: q.prompt, kind: q.kind,
        optionsJson: q.options.filter((o) => o.text.trim()), correctOptionIds: q.correct,
      });
      setQ({ prompt: '', kind: 'SINGLE', options: [{ id: 'a', text: '' }, { id: 'b', text: '' }], correct: [] });
      await onChange();
    } catch (e) { setError(e.data?.message || e.message); }
    finally { setSaving(false); }
  }
  async function removeQuestion(qid) {
    try { await del(`/api/hr/learning/questions/${qid}`); await onChange(); }
    catch (e) { setError(e.data?.message || e.message); }
  }

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-700">Quiz</span>
        <span className="text-xs text-gray-500">Pass ≥ {quiz.passThreshold}%, up to {quiz.maxAttempts ?? '∞'} attempts</span>
        <InfoTip text="The answer key never reaches the learner; scoring happens on the server." label="Quiz" />
      </div>

      <ul className="mb-3 space-y-2">
        {(quiz.questions || []).map((qq, i) => (
          <li key={qq.id} className="flex items-start justify-between rounded border border-gray-200 bg-white px-3 py-2 text-sm">
            <div>
              <div className="font-medium text-gray-800">{i + 1}. {qq.prompt} <span className="text-xs text-gray-400">({qq.kind})</span></div>
              <ul className="ml-3 mt-1 text-xs text-gray-600">
                {(qq.optionsJson || []).map((o) => (
                  <li key={o.id}>{(qq.correctOptionIds || []).includes(o.id) ? '✓ ' : '• '}{o.text}</li>
                ))}
              </ul>
            </div>
            {canManage ? <button className="text-xs text-red-500 hover:underline" onClick={() => removeQuestion(qq.id)}>×</button> : null}
          </li>
        ))}
        {(quiz.questions || []).length === 0 ? <li className="text-xs text-gray-400">No questions yet — add one below.</li> : null}
      </ul>

      {canManage ? (
        <div className="space-y-2 rounded border border-gray-200 bg-white p-3">
          <TextInput label="New question" value={q.prompt} onChange={(v) => setQ({ ...q, prompt: v })} />
          <div>
            <FieldLabel>Type</FieldLabel>
            <select className="rounded-md border border-gray-300 px-2 py-1 text-sm" value={q.kind} onChange={(e) => setQ({ ...q, kind: e.target.value, correct: [] })}>
              <option value="SINGLE">Single choice</option>
              <option value="MULTI">Multiple choice</option>
              <option value="TRUE_FALSE">True / False</option>
            </select>
          </div>
          <div className="space-y-1">
            {q.options.map((o, i) => (
              <div key={o.id} className="flex items-center gap-2">
                <input type={q.kind === 'MULTI' ? 'checkbox' : 'radio'} name="correct" checked={q.correct.includes(o.id)} onChange={() => toggleCorrect(o.id)} />
                <input className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm" placeholder={`Option ${i + 1}`} value={o.text} onChange={(e) => { const opts = q.options.slice(); opts[i] = { ...o, text: e.target.value }; setQ({ ...q, options: opts }); }} />
              </div>
            ))}
            <button className="text-xs text-blue-600 hover:underline" onClick={() => setQ({ ...q, options: [...q.options, { id: String.fromCharCode(97 + q.options.length), text: '' }] })}>+ option</button>
          </div>
          <PrimaryButton onClick={addQuestion} loading={saving}>Add question</PrimaryButton>
        </div>
      ) : null}
    </div>
  );
}

// ── Course settings ──────────────────────────────────────────────────────────────
function CourseSettings({ course, canManage, onChange, setError }) {
  const [d, setD] = useState({
    completionRule: course.completionRule, certificateEnabled: course.certificateEnabled, estMinutes: course.estMinutes ?? '', passThreshold: course.passThreshold ?? 70,
  });
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try { await put(`/api/hr/learning/courses/${course.id}`, { ...d, estMinutes: d.estMinutes === '' ? null : Number(d.estMinutes) }); await onChange(); }
    catch (e) { setError(e.data?.message || e.message); }
    finally { setSaving(false); }
  }
  return (
    <div className="max-w-lg space-y-4 rounded-lg border border-gray-200 bg-white p-4">
      <div>
        <FieldLabel tip="ALL_LESSONS = consume every required lesson; QUIZ_PASS = pass the quizzes; BOTH = both.">Completion rule</FieldLabel>
        <select className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm" value={d.completionRule} onChange={(e) => setD({ ...d, completionRule: e.target.value })}>
          <option value="ALL_LESSONS">All lessons</option>
          <option value="QUIZ_PASS">Quiz pass</option>
          <option value="BOTH">Both</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={d.certificateEnabled} onChange={(e) => setD({ ...d, certificateEnabled: e.target.checked })} />
        Issue a completion certificate
        <InfoTip text="On completion, a branded certificate PDF is minted to the learner's document vault (reuses the Letters engine)." label="Certificate" />
      </label>
      <TextInput label="Estimated minutes" type="number" value={String(d.estMinutes)} onChange={(v) => setD({ ...d, estMinutes: v })} />
      {canManage ? <PrimaryButton onClick={save} loading={saving}>Save settings</PrimaryButton> : null}
    </div>
  );
}

// ── Assign panel ─────────────────────────────────────────────────────────────────
function AssignPanel({ courseId, published, canManage, setError }) {
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ audienceScope: 'ALL', audienceDeptIds: '', audienceRoleIds: '', audienceEntityIds: '', audienceEmployeeIds: '', isMandatory: true, dueInDays: 7, recurrence: 'NONE', newJoinerRule: false, newJoinerWithinDays: 30 });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await get(`/api/hr/learning/courses/${courseId}/assignments`); setAssignments(r.items || []); }
    catch (e) { setError(e.data?.message || e.message); }
    finally { setLoading(false); }
  }, [courseId]);
  useEffect(() => { load(); }, [load]);

  function idList(s) { return String(s || '').split(',').map((x) => x.trim()).filter(Boolean); }

  async function createAssignment() {
    setSaving(true);
    try {
      await post(`/api/hr/learning/courses/${courseId}/assignments`, {
        audienceScope: form.audienceScope,
        audienceDeptIds: idList(form.audienceDeptIds), audienceRoleIds: idList(form.audienceRoleIds),
        audienceEntityIds: idList(form.audienceEntityIds), audienceEmployeeIds: idList(form.audienceEmployeeIds),
        isMandatory: form.isMandatory, dueInDays: Number(form.dueInDays) || null,
        recurrence: form.recurrence, newJoinerRule: form.newJoinerRule, newJoinerWithinDays: Number(form.newJoinerWithinDays) || 30,
      });
      await load();
    } catch (e) { setError(e.data?.message || e.message); }
    finally { setSaving(false); }
  }
  async function syncOne(id) { try { await post(`/api/hr/learning/assignments/${id}/sync`, {}); await load(); } catch (e) { setError(e.data?.message || e.message); } }
  async function removeOne(id) { if (!confirm('Remove this assignment? Existing enrollments are kept.')) return; try { await del(`/api/hr/learning/assignments/${id}`); await load(); } catch (e) { setError(e.data?.message || e.message); } }

  if (!published) return <p className="text-sm text-amber-700">Publish the course before assigning it.</p>;

  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-7 rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 text-sm font-semibold text-gray-700">Existing assignments</div>
        {loading ? <p className="text-sm text-gray-400">Loading…</p> : null}
        <ul className="space-y-2">
          {assignments.map((a) => (
            <li key={a.id} className="flex items-center justify-between rounded border border-gray-200 px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{a.audienceScope}</span> · {a.isMandatory ? 'Mandatory' : 'Optional'} · {a.recurrence}
                {a.newJoinerRule ? ` · new-joiner ${a.newJoinerWithinDays}d` : ''}
                <div className="text-xs text-gray-500">{a.completedCount}/{a.enrolledCount} completed</div>
              </div>
              {canManage ? (
                <div className="flex gap-2 text-xs">
                  <button className="text-blue-600 hover:underline" onClick={() => syncOne(a.id)}>Sync now</button>
                  <button className="text-red-500 hover:underline" onClick={() => removeOne(a.id)}>Remove</button>
                </div>
              ) : null}
            </li>
          ))}
          {!loading && assignments.length === 0 ? <li className="text-xs text-gray-400">No assignments yet.</li> : null}
        </ul>
      </div>

      {canManage ? (
        <div className="col-span-5 rounded-lg border border-gray-200 bg-white p-4 space-y-3">
          <div className="text-sm font-semibold text-gray-700">Assign training</div>
          <div>
            <FieldLabel tip="ALL/Entity/Department mirror the Announcement audience; ROLE targets by business role; SPECIFIC by employee ids.">Audience</FieldLabel>
            <select className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm" value={form.audienceScope} onChange={(e) => setForm({ ...form, audienceScope: e.target.value })}>
              {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {form.audienceScope === 'DEPARTMENT' ? <TextInput label="Department ids (comma-sep)" value={form.audienceDeptIds} onChange={(v) => setForm({ ...form, audienceDeptIds: v })} /> : null}
          {form.audienceScope === 'ROLE' ? <TextInput label="Business role ids (comma-sep)" value={form.audienceRoleIds} onChange={(v) => setForm({ ...form, audienceRoleIds: v })} /> : null}
          {form.audienceScope === 'ENTITY' ? <TextInput label="Entity ids (comma-sep)" value={form.audienceEntityIds} onChange={(v) => setForm({ ...form, audienceEntityIds: v })} /> : null}
          {form.audienceScope === 'SPECIFIC' ? <TextInput label="Employee ids (comma-sep)" value={form.audienceEmployeeIds} onChange={(v) => setForm({ ...form, audienceEmployeeIds: v })} /> : null}
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.isMandatory} onChange={(e) => setForm({ ...form, isMandatory: e.target.checked })} /> Mandatory
          </label>
          <TextInput label="Due within (days)" type="number" value={String(form.dueInDays)} onChange={(v) => setForm({ ...form, dueInDays: v })} />
          <div>
            <FieldLabel tip="ANNUAL re-assigns every year (POSH annual). The cron handles the boundary + new joiners.">Recurrence</FieldLabel>
            <select className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm" value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value })}>
              {RECURRENCE.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.newJoinerRule} onChange={(e) => setForm({ ...form, newJoinerRule: e.target.checked })} />
            Auto-assign new joiners
            <InfoTip text="POSH requires training within 30 days of joining — the daily cron auto-enrols in-audience new hires." label="New joiner" />
          </label>
          {form.newJoinerRule ? <TextInput label="Within (days)" type="number" value={String(form.newJoinerWithinDays)} onChange={(v) => setForm({ ...form, newJoinerWithinDays: v })} /> : null}
          <PrimaryButton onClick={createAssignment} loading={saving}>Assign &amp; fan out</PrimaryButton>
        </div>
      ) : null}
    </div>
  );
}
