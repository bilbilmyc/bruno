"""Run a pinned offline English → Simplified Chinese model in the cloud runner."""
import json
import pathlib
import re

MODEL = 'Helsinki-NLP/opus-mt-en-zh'
REVISION = '408d9bc410a388e1d9aef112a2daba955b945255'


def eligible(text):
    # Leave protocol values, examples, interpolation and markup out of translation.
    return (3 <= len(text) <= 400 and bool(re.search(r'[a-z]', text))
            and not re.search(r'[\r\n{}<>=$\\@]|https?://|\b(?:Bearer|localhost)\b', text)
            and not re.fullmatch(r'[a-z][A-Za-z0-9_.:/-]*', text))


def validate(source, translated):
    if (not isinstance(translated, str) or not translated.strip()
            or re.search(r'[\r\n=\x00]', translated)
            or not re.search(r'[\u3400-\u9fff]', translated)
            or len(translated) > max(40, len(source) * 3)):
        raise ValueError('Translation output failed validation')
    protected = r'\d+(?:\.\d+)*|\b[A-Z]{2,}\b'
    if re.findall(protected, source) != re.findall(protected, translated):
        raise ValueError('Translation changed numbers or protocol abbreviations')
    return translated.strip()


def translate_all(strings):
    import torch
    from transformers import MarianMTModel, MarianTokenizer
    torch.set_num_threads(2)
    tokenizer = MarianTokenizer.from_pretrained(MODEL, revision=REVISION)
    model = MarianMTModel.from_pretrained(MODEL, revision=REVISION, weights_only=True)
    model.eval()
    result = {}
    # Always exercise the actual model, even for a rebuild with no new UI text.
    samples = ['Create a new folder', 'Request timeout']
    for text in samples + strings:
        inputs = tokenizer('>>cmn_Hans<< ' + text, return_tensors='pt', truncation=False)
        if inputs['input_ids'].shape[1] > 256:
            raise ValueError('Unexpectedly long UI string')
        with torch.inference_mode():
            tokens = model.generate(**inputs, max_new_tokens=256, num_beams=4)
        result[text] = validate(text, tokenizer.decode(tokens[0], skip_special_tokens=True))
    return {text: result[text] for text in strings}


def extend_dictionary(root, baseline):
    candidates = set()
    for platform in ('win32', 'darwin'):
        candidates.update(json.loads((root / f'missing-{platform}.json').read_text()))
    new = sorted(candidates - set(baseline))
    if len(new) > 200:
        raise ValueError('More than 200 new strings: source review required')
    selected = [text for text in new if eligible(text)]
    translated = translate_all(selected)
    with (root / 'translations.txt').open('a', encoding='utf8') as dictionary:
        for source, target in translated.items():
            dictionary.write(f'\n{source}={target}')
    report = {'model': MODEL, 'revision': REVISION, 'translations': translated,
              'keptEnglish': [text for text in new if text not in translated]}
    (root / 'maintenance/translation-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    return report
