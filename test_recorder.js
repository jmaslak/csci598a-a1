// Headless check of composer.html's recorder state machine and the
// adjust-the-draft controls.
//
//   sed -n '/^<script>$/,/^<\/script>$/p' composer.html | sed '1d;$d' > /tmp/composer-check.js
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc test_recorder.js
//   node test_recorder.js        # same thing where node works
//
// Stubs just enough DOM and SpeechRecognition to drive both recorders without a
// browser or a microphone, then asserts what reached the page.

// jsc has print/readFile built in; give node the same two.
if (typeof print === "undefined") {
    var print = function (s) { console.log(s); };
}
if (typeof readFile === "undefined") {
    var readFile = function (path) { return require("fs").readFileSync(path, "utf8"); };
}

var failures = 0;
function check(label, got, want) {
    var ok = String(got) === String(want);
    if (!ok) { failures++; }
    print((ok ? "  pass  " : "  FAIL  ") + label +
          (ok ? "" : "\n          got:  " + got + "\n          want: " + want));
}

// ---------- DOM ----------
var els = {};
function El(id) {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this._text = "";
    this.innerHTML = "";
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.handlers = {};
    this.classes = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.modalOpen = false;
    var self = this;
    this.classList = {
        add: function (c) { self.classes[c] = true; },
        remove: function (c) { delete self.classes[c]; },
        contains: function (c) { return !!self.classes[c]; }
    };
}
Object.defineProperty(El.prototype, "textContent", {
    get: function () {
        var own = this._text;
        for (var i = 0; i < this.children.length; i++) own += this.children[i].textContent;
        return own;
    },
    set: function (v) { this._text = v; this.children = []; }
});
El.prototype.addEventListener = function (type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
};
El.prototype.fire = function (type) {
    var hs = this.handlers[type] || [];
    for (var i = 0; i < hs.length; i++) hs[i].call(this, {});
};
El.prototype.click = function () { this.fire("click"); };
El.prototype.appendChild = function (c) { this.children.push(c); };
El.prototype.setAttribute = function () {};
El.prototype.focus = function () {};
El.prototype.setSelectionRange = function () {};
El.prototype.showModal = function () { this.modalOpen = true; };
El.prototype.close = function () { this.modalOpen = false; };

var document = {
    getElementById: function (id) { return els[id] || (els[id] = new El(id)); },
    createElement: function () { return new El("(created)"); },
    documentElement: new El("html")
};
function $(id) { return document.getElementById(id); }

// ---------- timers, misc ----------
var timers = [], nextTimer = 1, pendingTimers = {};
function setTimeout(fn, ms) { var id = nextTimer++; pendingTimers[id] = fn; return id; }
function clearTimeout(id) { delete pendingTimers[id]; }
function setInterval() { return 0; }
function clearInterval() {}
function requestAnimationFrame() { return 0; }
function cancelAnimationFrame() {}
function fetch() { return new Promise(function () {}); }

// ---------- SpeechRecognition ----------
var recognizers = [];
function FakeSR() {
    this.started = false;
    this.aborted = false;
    recognizers.push(this);
}
FakeSR.prototype.start = function () { this.started = true; };
FakeSR.prototype.stop = function () {
    this.started = false;
    // Real engines deliver the last final result after stop(), then onend.
    if (this.tail) this.emit(this.tail, true);
    if (this.onend) this.onend();
};
FakeSR.prototype.fail = function (code) {
    if (this.onerror) this.onerror({ error: code });
};
FakeSR.prototype.emit = function (text, isFinal) {
    this.onresult({
        resultIndex: 0,
        results: [{ 0: { transcript: text }, isFinal: !!isFinal, length: 1 }]
    });
};
function latest() { return recognizers[recognizers.length - 1]; }

var navigator = { language: "en-US" };
var window = {
    SpeechRecognition: FakeSR,
    scrollTo: function () {},
    AudioContext: null,
    __composerTest: true    // asks the page to expose pure helpers for the checks below
};

// ---------- seed initial attribute state from the real markup ----------
// Stubs default to visible/enabled; the page relies on `hidden` and `disabled`
// attributes being set, so read them off composer.html rather than assume.
(function seedFromMarkup() {
    var html = readFile("composer.html");
    var tagRe = /<[a-zA-Z][^>]*>/g, tag;
    while ((tag = tagRe.exec(html)) !== null) {
        var idMatch = /\sid="([^"]+)"/.exec(tag[0]);
        if (!idMatch) continue;
        var el = $(idMatch[1]);
        if (/\shidden(\s|>|=)/.test(tag[0])) el.hidden = true;
        if (/\sdisabled(\s|>|=)/.test(tag[0])) el.disabled = true;
    }
})();

// ---------- run the page script ----------
var src = readFile("/tmp/composer-check.js");
eval(src);

print("recorder state machine");

// --- compose: speak, then stop -> should auto-run cleanup ---
$("mic-btn").click();
check("compose: recognition started", latest().started, true);
latest().emit("Um so hi everybody, ", true);
latest().emit("Mom went into the ER on Thursday.", true);
check("compose: live transcript shows speech",
      $("transcript-live").textContent.indexOf("Mom went into the ER") >= 0, true);
check("compose: submit button enabled", $("to-cleanup").disabled, false);

// --- revise: open the panel, speak, check it transcribes ---
$("rev-toggle").click();
check("revise: panel opened", $("rev-panel").hidden, false);
check("revise: mic not disabled", $("rev-mic-btn").disabled, false);

$("rev-mic-btn").click();
check("revise: recognition started", latest().started, true);
check("revise: mic shows live", $("rev-mic-btn").dataset.live, "true");

latest().emit("add that surgery is Thursday", false);   // interim
check("revise: interim text rendered",
      $("rev-live").textContent.indexOf("add that surgery is Thursday") >= 0, true);

latest().emit("add that the surgery is Thursday morning. ", true);
check("revise: final text rendered",
      $("rev-live").textContent.indexOf("surgery is Thursday morning") >= 0, true);
check("revise: apply button enabled", $("rev-apply").disabled, false);

// --- stop with a trailing final: must not be dropped, must auto-apply ---
var applied = false;
$("rev-apply").addEventListener("click", function () { applied = true; });
latest().tail = "and take out the food part.";
$("rev-mic-btn").click();
check("revise: tail after stop() captured",
      $("rev-live").textContent.indexOf("take out the food part") >= 0, true);
check("revise: auto-applied on stop", applied, true);

print("guided questions");

$("pick-guided").click();
check("guided: opens on the person", $("guided-heading").textContent, "Who is this site about?");
check("guided: says the condition comes later",
      $("guided-aside").textContent.indexOf("what's been happening") >= 0, true);
check("guided: card shown", $("step-guided").hidden, false);
check("guided: way out offers the editor", $("guided-escape").textContent, "I'd rather just write it");
check("guided: next disabled before an answer", $("guided-next").disabled, true);

$("guided-mic-btn").click();
latest().emit("This is about my mom, Linda. ", true);
check("guided: answer transcribed", $("guided-live").textContent.indexOf("my mom, Linda") >= 0, true);
check("guided: next enabled", $("guided-next").disabled, false);
check("guided: way out now offers to finish", $("guided-escape").textContent, "Finish with what I've said");

// Stopping the mic moves on, the same way it submits on the other recorders.
$("guided-mic-btn").click();
check("guided: stop advances a question", $("guided-heading").textContent, "What's been happening?");
check("guided: counter follows", $("guided-count").textContent, "Question 2 of 6");
check("guided: buffer cleared for the new question", $("guided-next").disabled, true);

$("guided-back").click();
check("guided: back returns to question 1", $("guided-count").textContent, "Question 1 of 6");
check("guided: the earlier answer is still there",
      $("guided-live").textContent.indexOf("my mom, Linda") >= 0, true);

$("guided-skip").click();
$("guided-sample").click();
check("guided: sample answer loads for this question",
      $("guided-live").textContent.indexOf("chest pain") >= 0, true);
$("guided-next").click();

var guidedText = window.__composerTestHooks.guidedTranscript;
check("guided: each answer is headed by its question",
      guidedText().indexOf("Who this site is about:\nThis is about my mom, Linda."), 0);
check("guided: later answers are kept", guidedText().indexOf("What has happened:") > 0, true);
check("guided: unanswered questions are left out", guidedText().indexOf("Anything else:"), -1);

// Skip on to the last question, however many there turn out to be.
for (var n = 0; n < 20 && $("guided-next").textContent !== "Turn this into an entry"; n++) {
    $("guided-skip").click();
}
check("guided: last question relabels the button", $("guided-next").textContent, "Turn this into an entry");
$("guided-next").click();
check("guided: finishing runs the cleanup step", $("step-process").hidden, false);
check("guided: questions card hidden after finishing", $("step-guided").hidden, true);

// The last-resort regex cleaner has to drop the headings itself.
var localClean = window.__composerTestHooks.localClean;
check("guided: on-device cleanup drops the headings",
      localClean("Who this site is about:\nThis is about my mom.").body.indexOf("Who this site"), -1);
check("guided: on-device cleanup keeps the answer",
      localClean("Who this site is about:\nThis is about my mom.").body, "This is about my mom.");

print("adjust the draft");

// --- sliders: captions follow the position ---
check("adjust: captions start at 'as it is now'", $("adj-length-out").textContent, "As it is now");
$("adj-length").value = "1";
$("adj-length").fire("input");
check("adjust: length caption at 1", $("adj-length-out").textContent, "Just the essentials");
$("adj-emotion").value = "5";
$("adj-emotion").fire("input");
check("adjust: emotion caption at 5", $("adj-emotion-out").textContent, "Openly heartfelt");

// --- suggest: too short refuses, long enough asks Claude (fetch never resolves here) ---
$("body-field").value = "Hi.";
$("adj-suggest").click();
check("adjust: refuses a too-short entry", $("adj-error").hidden, false);
check("adjust: button untouched when refused", $("adj-suggest").disabled, false);

$("body-field").value = "Mom went into the ER on Thursday night with chest pain.";
$("adj-suggest").click();
check("adjust: error cleared on retry", $("adj-error").hidden, true);
check("adjust: button disabled while asking", $("adj-suggest").disabled, true);
check("adjust: button says it is asking", $("adj-suggest").textContent, "Asking Claude\u2026");
check("adjust: textarea stays visible while asking", $("body-field").hidden, false);

// --- word diff: the pure helper behind the tracked-changes view ---
var hooks = window.__composerTestHooks;
check("diff: hooks exposed", typeof (hooks && hooks.wordDiff), "function");
function flat(ops) {
    return ops.map(function (o) { return o.op + ":" + o.tokens.join("_"); }).join(" ");
}
check("diff: one word swapped", flat(hooks.wordDiff("a b c", "a x c")), "eq:a del:b ins:x eq:c");
check("diff: identical paragraphs are one eq run",
      flat(hooks.wordDiff("p1\n\np2", "p1\n\np2")), "eq:p1_\n\n_p2");
check("diff: whitespace differences are not changes",
      flat(hooks.wordDiff("a  b\nc", "a b c")), "eq:a_b_c");
check("diff: words dropped at the end", flat(hooks.wordDiff("a b c d", "a b")), "eq:a_b del:c_d");
check("diff: empty before, text after", flat(hooks.wordDiff("", "a b")), "ins:a_b");


// --- recognizer errors: none of them may fail silently ---
// A quiet failure looks exactly like a recorder that is still listening, so
// every code has to reach the writer. `network` is the one that actually bit:
// the mic opens, the browser's transcription service never answers.
print("\nrecognizer errors");

function freshCompose() {
    $("speech-fallback").hidden = true;
    $("mic-btn").disabled = false;
    $("mic-btn").click();
    return latest();
}

var rec = freshCompose();
rec.fail("network");
check("network: fallback box shown", $("speech-fallback").hidden, false);
check("network: reason names the browser's service",
      $("fallback-reason").textContent.indexOf("couldn't reach the service") >= 0, true);
check("network: status says transcription, not microphone",
      $("status").textContent, "Transcription unavailable");
check("network: diagnosis carries the code",
      $("mic-diag").textContent.indexOf("recognizer error: network") >= 0, true);
check("network: recording stopped", $("mic-btn").dataset.live, "false");

rec = freshCompose();
rec.fail("language-not-supported");
check("language-not-supported: fallback shown", $("speech-fallback").hidden, false);
check("language-not-supported: names the language",
      $("fallback-reason").textContent.indexOf("en-US") >= 0, true);

rec = freshCompose();
rec.fail("some-code-from-the-future");
check("unknown code: still reaches the writer", $("speech-fallback").hidden, false);
check("unknown code: quotes the code",
      $("fallback-reason").textContent.indexOf("some-code-from-the-future") >= 0, true);

// aborted is what stop() raises; it must not look like a failure.
rec = freshCompose();
rec.fail("aborted");
check("aborted: no fallback", $("speech-fallback").hidden, true);
check("aborted: still recording", $("mic-btn").dataset.live, "true");
hooks.stopRecording();

// no-speech keeps the recorder running and only nudges the status line.
rec = freshCompose();
rec.fail("no-speech");
check("no-speech: no fallback", $("speech-fallback").hidden, true);
check("no-speech: prompts to keep going", $("status").textContent, "Didn't catch that \u2014 keep talking");
check("no-speech: still recording", $("mic-btn").dataset.live, "true");
hooks.stopRecording();

print(failures ? "\n" + failures + " FAILED" : "\nall passed");
