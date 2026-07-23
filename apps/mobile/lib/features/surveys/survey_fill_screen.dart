// Survey fill form — renders one occurrence's questions by type (number pills for
// SCALE/LIKERT, 0–10 for NPS, radio SINGLE, checkbox MULTI +Other, textarea TEXT),
// submits { answers } to the anonymity firewall, and shows the receipt on success.
// Server 422 (missing required) and 409 (already submitted) are surfaced verbatim.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/endpoints.dart';
import '../../core/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/state_views.dart';
import 'surveys_providers.dart';

class SurveyFillScreen extends ConsumerStatefulWidget {
  const SurveyFillScreen({super.key, required this.occurrenceId});

  final String occurrenceId;

  @override
  ConsumerState<SurveyFillScreen> createState() => _SurveyFillScreenState();
}

class _SurveyFillScreenState extends ConsumerState<SurveyFillScreen> {
  final Map<String, int> _numeric = {};
  final Map<String, String> _single = {};
  final Map<String, Set<String>> _multi = {};
  final Map<String, String> _text = {}; // TEXT answers + MULTI "Other" free text

  bool _submitting = false;
  bool _dismissing = false;
  String? _error;
  String? _receipt;

  String get _id => widget.occurrenceId;

  List<Map<String, dynamic>> _buildAnswers(List<Map<String, dynamic>> questions) {
    final answers = <Map<String, dynamic>>[];
    for (final q in questions) {
      final id = q['id'].toString();
      final type = (q['type'] ?? '').toString().toUpperCase();
      switch (type) {
        case 'NPS':
        case 'SCALE':
        case 'LIKERT':
          if (_numeric.containsKey(id)) {
            answers.add({'questionId': id, 'numericValue': _numeric[id]});
          }
          break;
        case 'SINGLE':
          final v = _single[id];
          if (v != null && v.isNotEmpty) {
            answers.add({'questionId': id, 'choiceValues': [v]});
          }
          break;
        case 'MULTI':
          final choices = (_multi[id] ?? const <String>{}).toList();
          final allowOther = q['allowOther'] == true;
          final other = (_text[id] ?? '').trim();
          final hasOther = allowOther && other.isNotEmpty;
          if (choices.isNotEmpty || hasOther) {
            answers.add({
              'questionId': id,
              'choiceValues': choices,
              if (hasOther) 'textValue': other,
            });
          }
          break;
        case 'TEXT':
          final v = (_text[id] ?? '').trim();
          if (v.isNotEmpty) answers.add({'questionId': id, 'textValue': v});
          break;
      }
    }
    return answers;
  }

  Future<void> _submit(List<Map<String, dynamic>> questions) async {
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final res = await ref.read(apiClientProvider).post(
        Api.surveySubmit(_id),
        {'answers': _buildAnswers(questions)},
      );
      final token = res is Map ? res['receiptToken']?.toString() : null;
      setState(() => _receipt = (token == null || token.isEmpty) ? 'submitted' : token);
      ref.invalidate(surveysProvider);
    } on ApiException catch (e) {
      // 422 (missing required) / 409 (already submitted) — verbatim server message.
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not submit the survey. Please try again.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _dismiss() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("Don't ask again?"),
        content: const Text('This survey will stop reminding you. It counts as a non-response.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Dismiss')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _dismissing = true);
    try {
      await ref.read(apiClientProvider).post(Api.surveyDismiss(_id), {});
      ref.invalidate(surveysProvider);
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      setState(() {
        _dismissing = false;
        _error = e.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(surveyDetailProvider(_id));
    return Scaffold(
      appBar: AppBar(title: const Text('Survey')),
      body: _receipt != null
          ? _ThankYou(receipt: _receipt!)
          : AsyncView<Map<String, dynamic>>(
              value: async,
              onRefresh: () async => ref.refresh(surveyDetailProvider(_id).future),
              data: (occ) => _form(occ),
            ),
    );
  }

  Widget _form(Map<String, dynamic> occ) {
    final survey = occ['survey'] is Map ? (occ['survey'] as Map).cast<String, dynamic>() : const <String, dynamic>{};
    final anonymous = survey['anonymous'] == true;
    final title = (survey['title'] ?? 'Survey').toString();
    final description = survey['description']?.toString();
    final questions = asList(occ, keys: const ['questions']);

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(title,
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: BrandColors.text)),
        if (description != null && description.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(description, style: const TextStyle(color: BrandColors.muted, fontSize: 13, height: 1.35)),
        ],
        if (anonymous) ...[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: BrandColors.tealSoft,
              borderRadius: BorderRadius.circular(BrandRadii.md),
              border: Border.all(color: BrandColors.border),
            ),
            child: const Row(
              children: [
                Icon(Icons.lock_outline, size: 16, color: BrandColors.tealDark),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'This survey is anonymous. Your answers are never linked to your identity.',
                    style: TextStyle(fontSize: 12.5, color: BrandColors.text),
                  ),
                ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 18),
        for (var i = 0; i < questions.length; i++) ...[
          _QuestionCard(
            index: i + 1,
            question: questions[i],
            numeric: _numeric,
            single: _single,
            multi: _multi,
            text: _text,
            onChanged: () => setState(() => _error = null),
          ),
          const SizedBox(height: 12),
        ],
        if (_error != null) ...[
          ErrorBanner(message: _error!),
          const SizedBox(height: 12),
        ],
        FilledButton(
          onPressed: _submitting ? null : () => _submit(questions),
          child: _submitting
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Text('Submit'),
        ),
        const SizedBox(height: 10),
        OutlinedButton(
          onPressed: _dismissing ? null : _dismiss,
          child: _dismissing
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text("Don't ask me again"),
        ),
        const SizedBox(height: 28),
      ],
    );
  }
}

class _QuestionCard extends StatefulWidget {
  const _QuestionCard({
    required this.index,
    required this.question,
    required this.numeric,
    required this.single,
    required this.multi,
    required this.text,
    required this.onChanged,
  });

  final int index;
  final Map<String, dynamic> question;
  final Map<String, int> numeric;
  final Map<String, String> single;
  final Map<String, Set<String>> multi;
  final Map<String, String> text;
  final VoidCallback onChanged;

  @override
  State<_QuestionCard> createState() => _QuestionCardState();
}

class _QuestionCardState extends State<_QuestionCard> {
  TextEditingController? _textController;

  Map<String, dynamic> get q => widget.question;
  String get _qid => q['id'].toString();
  String get _type => (q['type'] ?? '').toString().toUpperCase();

  @override
  void initState() {
    super.initState();
    if (_type == 'TEXT' || _type == 'MULTI') {
      _textController = TextEditingController(text: widget.text[_qid] ?? '');
    }
  }

  @override
  void dispose() {
    _textController?.dispose();
    super.dispose();
  }

  List<Map<String, dynamic>> get _options {
    final raw = q['options'];
    return raw is List ? asList(raw) : const [];
  }

  @override
  Widget build(BuildContext context) {
    final prompt = (q['prompt'] ?? '').toString();
    final required = q['required'] == true;

    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          RichText(
            text: TextSpan(
              style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: BrandColors.text),
              children: [
                TextSpan(text: '${widget.index}. $prompt'),
                if (required)
                  const TextSpan(text: '  *', style: TextStyle(color: BrandColors.danger)),
              ],
            ),
          ),
          const SizedBox(height: 12),
          _control(),
        ],
      ),
    );
  }

  Widget _control() {
    switch (_type) {
      case 'NPS':
        return _numberPills(0, 10, q['scaleMinLabel'], q['scaleMaxLabel']);
      case 'SCALE':
      case 'LIKERT':
        final lo = (q['scaleMin'] as num?)?.toInt() ?? 1;
        final hi = (q['scaleMax'] as num?)?.toInt() ?? 5;
        return _numberPills(lo, hi, q['scaleMinLabel'], q['scaleMaxLabel']);
      case 'SINGLE':
        return _singleChoice();
      case 'MULTI':
        return _multiChoice();
      case 'TEXT':
        return _freeText();
      default:
        return const Text('Unsupported question type', style: TextStyle(color: BrandColors.muted, fontSize: 12));
    }
  }

  Widget _numberPills(int lo, int hi, Object? minLabel, Object? maxLabel) {
    final selected = widget.numeric[_qid];
    final count = hi - lo + 1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: List.generate(count.clamp(0, 30), (i) {
            final value = lo + i;
            final isSel = selected == value;
            return InkWell(
              borderRadius: BorderRadius.circular(BrandRadii.pill),
              onTap: () {
                setState(() => widget.numeric[_qid] = value);
                widget.onChanged();
              },
              child: Container(
                width: 40,
                height: 40,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: isSel ? BrandColors.teal : BrandColors.card,
                  shape: BoxShape.circle,
                  border: Border.all(color: isSel ? BrandColors.teal : BrandColors.border, width: 1.4),
                ),
                child: Text('$value',
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: isSel ? Colors.white : BrandColors.text,
                    )),
              ),
            );
          }),
        ),
        if ((minLabel != null && minLabel.toString().isNotEmpty) ||
            (maxLabel != null && maxLabel.toString().isNotEmpty)) ...[
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Flexible(
                child: Text(minLabel?.toString() ?? '',
                    style: const TextStyle(color: BrandColors.muted, fontSize: 11)),
              ),
              Flexible(
                child: Text(maxLabel?.toString() ?? '',
                    textAlign: TextAlign.right,
                    style: const TextStyle(color: BrandColors.muted, fontSize: 11)),
              ),
            ],
          ),
        ],
      ],
    );
  }

  Widget _singleChoice() {
    final selected = widget.single[_qid];
    return Column(
      children: _options.map((o) {
        final value = o['value']?.toString() ?? '';
        final label = (o['label'] ?? value).toString();
        return RadioListTile<String>(
          value: value,
          groupValue: selected,
          contentPadding: EdgeInsets.zero,
          visualDensity: VisualDensity.compact,
          activeColor: BrandColors.teal,
          title: Text(label, style: const TextStyle(fontSize: 14, color: BrandColors.text)),
          onChanged: (v) {
            setState(() => widget.single[_qid] = v ?? '');
            widget.onChanged();
          },
        );
      }).toList(),
    );
  }

  Widget _multiChoice() {
    final set = widget.multi.putIfAbsent(_qid, () => <String>{});
    final allowOther = q['allowOther'] == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ..._options.map((o) {
          final value = o['value']?.toString() ?? '';
          final label = (o['label'] ?? value).toString();
          final checked = set.contains(value);
          return CheckboxListTile(
            value: checked,
            contentPadding: EdgeInsets.zero,
            visualDensity: VisualDensity.compact,
            controlAffinity: ListTileControlAffinity.leading,
            activeColor: BrandColors.teal,
            title: Text(label, style: const TextStyle(fontSize: 14, color: BrandColors.text)),
            onChanged: (v) {
              setState(() {
                if (v == true) {
                  set.add(value);
                } else {
                  set.remove(value);
                }
              });
              widget.onChanged();
            },
          );
        }),
        if (allowOther) ...[
          const SizedBox(height: 8),
          TextField(
            controller: _textController,
            decoration: const InputDecoration(
              labelText: 'Other',
              hintText: 'Add your own answer',
              isDense: true,
            ),
            onChanged: (v) {
              widget.text[_qid] = v;
              widget.onChanged();
            },
          ),
        ],
      ],
    );
  }

  Widget _freeText() {
    return TextField(
      controller: _textController,
      minLines: 3,
      maxLines: 6,
      decoration: const InputDecoration(
        hintText: 'Type your answer…',
        alignLabelWithHint: true,
      ),
      onChanged: (v) {
        widget.text[_qid] = v;
        widget.onChanged();
      },
    );
  }
}

class _ThankYou extends StatelessWidget {
  const _ThankYou({required this.receipt});

  final String receipt;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 64,
              height: 64,
              alignment: Alignment.center,
              decoration: const BoxDecoration(color: BrandColors.successSoft, shape: BoxShape.circle),
              child: const Icon(Icons.check_rounded, size: 34, color: BrandColors.success),
            ),
            const SizedBox(height: 16),
            const Text('Thank you!',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: BrandColors.text)),
            const SizedBox(height: 6),
            const Text(
              'Your response has been recorded.',
              textAlign: TextAlign.center,
              style: TextStyle(color: BrandColors.muted, fontSize: 13.5),
            ),
            if (receipt != 'submitted') ...[
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: BrandColors.bg,
                  borderRadius: BorderRadius.circular(BrandRadii.md),
                  border: Border.all(color: BrandColors.border),
                ),
                child: Column(
                  children: [
                    const Text('Receipt', style: TextStyle(color: BrandColors.muted, fontSize: 11)),
                    const SizedBox(height: 2),
                    SelectableText(receipt,
                        style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: BrandColors.text)),
                  ],
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'This receipt proves you took part — it does not link to your answers.',
                textAlign: TextAlign.center,
                style: TextStyle(color: BrandColors.muted, fontSize: 11),
              ),
            ],
            const SizedBox(height: 24),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    );
  }
}
