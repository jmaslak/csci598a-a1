// Headless check of composer.html's recorder state machine.
//
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc test_recorder.js
//
// Stubs just enough DOM and SpeechRecognition to drive both recorders without a
// browser or a microphone, then asserts what reached the page.

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
    AudioContext: null
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

print(failures ? "\n" + failures + " FAILED" : "\nall passed");
