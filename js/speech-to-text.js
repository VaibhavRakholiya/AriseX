/**
 * Speech-to-text via Web Speech API (SpeechRecognition / webkitSpeechRecognition).
 * Toggle mic button to dictate into a textarea or contenteditable field.
 */
const SpeechToText = (() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    let activeSession = null;

    function isSupported() {
        return !!SpeechRecognition;
    }

    function toast(msg, type) {
        if (window.UI?.toast) {
            window.UI.toast(msg, type);
        }
    }

    function insertTextAtCursor(el, text) {
        if (!el || !text) return;

        let insert = text;
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            const start = el.selectionStart ?? el.value.length;
            const end = el.selectionEnd ?? start;
            const val = el.value;
            if (start > 0 && val[start - 1] && !/\s/.test(val[start - 1]) && !/^\s/.test(insert)) {
                insert = ' ' + insert;
            }
            el.value = val.slice(0, start) + insert + val.slice(end);
            const pos = start + insert.length;
            el.selectionStart = el.selectionEnd = pos;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        el.focus();
        const sel = window.getSelection();
        if (sel?.rangeCount) {
            const range = sel.getRangeAt(0);
            if (!range.collapsed) range.deleteContents();
            const before = range.startContainer.textContent?.slice(0, range.startOffset) || '';
            if (before.length > 0 && !/\s$/.test(before) && !/^\s/.test(insert)) {
                insert = ' ' + insert;
            }
        }
        document.execCommand('insertText', false, insert);
    }

    function setButtonListening(button, listening) {
        if (!button) return;
        const icon = button.querySelector('i');
        button.classList.toggle('is-recording', listening);
        button.setAttribute('aria-pressed', listening ? 'true' : 'false');
        button.title = listening ? 'Stop dictation' : 'Speech to text';
        if (icon) {
            icon.className = listening ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone';
        }
    }

    function errorMessage(event) {
        switch (event.error) {
            case 'not-allowed':
            case 'service-not-allowed':
                return 'Microphone access denied';
            case 'no-speech':
                return 'No speech detected — try again';
            case 'network':
                return 'Speech recognition needs a network connection';
            case 'audio-capture':
                return 'No microphone found';
            case 'aborted':
                return null;
            default:
                return 'Speech recognition failed';
        }
    }

    function startSession(button, targetEl) {
        if (!SpeechRecognition) {
            toast('Speech to text is not supported in this browser', 'warning');
            return;
        }

        stopAll();

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = navigator.language || 'en-US';

        const session = {
            button,
            targetEl,
            recognition,
            stop() {
                if (session.stopped) return;
                session.stopped = true;
                try {
                    recognition.stop();
                } catch {
                    /* already stopped */
                }
                setButtonListening(button, false);
                if (activeSession === session) activeSession = null;
            },
        };

        recognition.onresult = (event) => {
            let transcript = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                if (event.results[i].isFinal) {
                    transcript += event.results[i][0].transcript;
                }
            }
            if (transcript) {
                insertTextAtCursor(targetEl, transcript);
            }
        };

        recognition.onerror = (event) => {
            const msg = errorMessage(event);
            if (msg) toast(msg, 'error');
            session.stop();
        };

        recognition.onend = () => {
            if (!session.stopped) {
                try {
                    recognition.start();
                } catch {
                    session.stop();
                }
                return;
            }
            setButtonListening(button, false);
            if (activeSession === session) activeSession = null;
        };

        activeSession = session;
        setButtonListening(button, true);
        targetEl.focus();

        try {
            recognition.start();
        } catch {
            toast('Could not start speech recognition', 'error');
            session.stop();
        }
    }

    function attach(button, targetEl) {
        if (!button || !targetEl) return;

        if (!isSupported()) {
            button.disabled = true;
            button.title = 'Speech to text not supported in this browser';
            button.setAttribute('aria-disabled', 'true');
            return;
        }

        button.addEventListener('click', (e) => {
            e.preventDefault();
            if (activeSession?.button === button) {
                activeSession.stop();
                return;
            }
            startSession(button, targetEl);
        });
    }

    function stopAll() {
        if (activeSession) activeSession.stop();
    }

    return { isSupported, attach, stopAll, insertTextAtCursor };
})();

window.SpeechToText = SpeechToText;
