/* ==================================================
   FOOBOX — CUSTOM LIGHTBOX
   ==================================================
   VERSION: 2026-09-11-a-unified

   WHAT CHANGED, AND WHY
   ---------------------
   The previous version had two renderers. Mobile drew
   the photograph into its own layer; desktop used
   FooBox's stage and then measured and aligned a
   caption against it. Everything was synchronised by
   guessing — a rAF "has it stopped moving yet" loop, a
   250ms setInterval, a 90ms settle timeout, and a
   MutationObserver on document.body.

   None of that is necessary. FooBox raises real
   lifecycle events on the instance element, carrying
   the item that is ABOUT to load:

       foobox.beforeLoad -> e.fb.item
         { url, index, element (the gallery anchor), ... }
       foobox.afterLoad
       foobox.close

   Verified live, 11 September 2026, including on open
   and not just on navigation. That single fact removes
   every guess in this file: we know which picture is
   coming before it arrives, and which anchor it came
   from, so a caption never has to be matched back by
   href and nothing ever has to be polled.

   THE FLASH
   ---------
   FooBox's own sequence, read out of foobox.free.min
   (v2.8.5), is strictly serial:

       load(next) -> transitionOut(current)
                  -> resize()
                  -> next.css({opacity:''})     // back to 0
                  -> transitionIn(next)         // 0 -> 1
                  -> swap classes, empty(current)

   transitionOutSpeed was 0 and transitionInSpeed 80, so
   the outgoing picture vanished instantly and the
   incoming one ramped up from zero over about five
   frames. Nothing was ever fully painted in between,
   and because --vy-ground is 85% white the gallery grid
   read straight through. That is the flash.

   It cannot be tuned away: the two transitions are
   sequenced by callbacks, so they can never overlap. So
   we stop letting FooBox paint at all.

   THE ARCHITECTURE NOW
   --------------------
   FooBox is an invisible state machine at EVERY width.
   Its stage keeps navigation, swipe, keyboard, preload
   and close; it simply never draws. We draw, into two
   stacked layers:

       .vy-viewer
         .vy-stack                 <- the available box
           .vy-layer               <- two of these
             .vy-frame             <- width == the picture's width
               img.vy-photo
               .vy-caption         <- width:100% of the frame

   A slide is committed ATOMICALLY: the incoming layer is
   built while it is still invisible — image decoded,
   caption composed, geometry set — and only then do the
   two layers swap. There is never a frame without a
   picture, so there is nothing to fade and nothing to
   flash. The swap is a hard cut on purpose; see show().

   Because the caption is a child of the frame at
   width:100%, it is EXACTLY the picture's width by
   construction. No alignment pass, no width floor, no
   two-pass convergence, no per-slide measuring.

   THE RESERVE IS KEPT — ON DESKTOP
   --------------------------------
   Measuring the caption per picture is what used to make
   advancing feel jumpy: the caption's height sets the
   picture's height budget, so a two-line caption
   followed by a four-line one RESIZED the photograph
   mid-navigation. On desktop the tallest caption in the
   gallery is therefore measured once and that constant
   is the budget for every slide, so the picture's own
   aspect ratio becomes the only thing that changes its
   size. Measured cost on Sollbruchstelle at 1440x900:
   21% of the height.

   On a phone the same reserve costs 37%, to accommodate
   one seven-line caption across all 95 slides, and buys
   almost nothing — a phone crops the picture by WIDTH
   nearly every time, so the caption was not resizing it
   anyway. So mobile fits per picture. That is the one
   deliberate breakpoint branch in this file; see the
   note above the constants.

   What is new at both breakpoints: the caption sits
   FLUSH under the photograph rather than being pinned to
   the bottom of a reserved band, and it is the
   photograph's width by construction rather than by
   measurement.

   SAFETY
   ------
   FooBox's stage is only hidden once our viewer exists,
   via .vy-ready on the modal. If anything in here
   throws, FooBox renders normally instead of the visitor
   getting an empty screen.

   HARD RULE, UNCHANGED
   --------------------
   Never hide or restyle .fbx-inner-spacer. FooBox's
   getMaxSize() measures its padding to size every item;
   display:none collapses the computed size and nothing
   is laid out at all.
   ================================================== */
(function () {
  'use strict';

  var VERSION = '2026-09-11-a-unified';

  /* ==================================================
     TUNING
     ==================================================
     Geometry that belongs to the page lives in the CSS
     (--vy-gutter, --vy-pad-top, --vy-pad-bottom,
     --vy-nav-h, --vy-gap). Only arithmetic lives here.
     ================================================== */

  /* ONE DELIBERATE BREAKPOINT BRANCH, AND THIS IS IT.
     -------------------------------------------------
     DESKTOP reserves a constant caption band for the
     whole gallery, so caption length can never resize
     the photograph between slides. Measured on
     Sollbruchstelle (95 captions, 1440x900): the tallest
     caption is 160px against an 820px stack, so the
     reserve costs 21% of the height and the picture area
     is identical on every slide. That is a good trade.

     MOBILE fits the caption to each picture instead.
     The same measurement on a 390x844 phone gives a
     tallest caption of 252px against a 706px stack — a
     constant band would cost 37% of the screen on all 95
     slides to accommodate one seven-line outlier, while
     buying almost nothing, because on a phone the
     photograph is width-limited in nearly every case and
     so was never being resized by the caption anyway.

     Everything else — the markup, the commit, the
     caption, the toggle, the close — is shared. This is
     one boolean, not a second renderer. */

  /* DESKTOP: ceiling on the share of the box the reserve
     may claim. Without it the layout has a death spiral:
     a very long caption steals the height budget -> the
     picture shrinks -> because the caption is as wide as
     the picture it gets narrower -> narrower wraps taller
     -> the picture shrinks again. Past the ceiling a
     caption scrolls inside its own card instead. */
  var RESERVE_MAX_SHARE = 0.45;

  /* Breathing room added to the tallest measured caption. */
  var RESERVE_PAD = 10;

  /* DESKTOP: width the gallery's captions are measured at
     when the one shared reserve is worked out. A stand-in
     for "a typical picture", and it errs NARROW on
     purpose: narrower wraps taller, so the reserve comes
     out big enough rather than one line short. */
  var MEASURE_RATIO = 0.60;

  /* MOBILE: the same ceiling, applied per caption rather
     than per gallery. This is the guard that stops the
     spiral described above. */
  var CAPTION_MAX_SHARE_MOBILE = 0.60;

  /* MOBILE: passes of the width/height fit. The caption's
     height depends on its width, which depends on the
     picture, which depends on the caption's height — so
     it is solved by iteration. It converges in two; the
     third is free insurance. All of it happens on an
     INVISIBLE layer, so no intermediate state is ever
     painted, which is exactly what the old code could not
     say. */
  var FIT_PASSES = 3;

  /* Never let the picture collapse to nothing, whatever
     the caption does. */
  var MIN_BAND = 40;

  var mobile = window.matchMedia('(max-width: 999px)');


  /* ==================================================
     ==================================================
     PART 1 — THE CAPTION CONTENT
     ==================================================
     Carried over unchanged from 2026-09-01-d. This is
     content logic and it is correct; it is reproduced in
     full rather than rewritten or condensed.
     ================================================== */

  /* Attribute values arrive double-encoded from
     FooGallery ("black &amp;amp; white"), so one decode
     pass is needed. A textarea decodes without executing. */
  function decodeEntities(value) {
    if (!value) { return ''; }
    var box = document.createElement('textarea');
    box.innerHTML = value;
    return box.value;
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* The Description field contains literal <br> tags, and in
     Sollbruchstelle they sit on their own lines — "B&W fiber
     print\n<br>\n50 x 58 cm". Turning each <br> into a newline
     therefore produced runs of two and three newlines, and under
     white-space: pre-line a run of two draws a BLANK LINE.

     There is never a blank line inside a block. The one gap in
     the caption — between the dark block and the grey one — is
     drawn by --vy-title-gap (margin-top on .vy-cap-detail), not
     by empty text. So: drop empty lines outright and rejoin with
     a single newline. Runs of spaces inside a line collapse too,
     which quietly fixes "Installation view  (detail)". */
  function toLines(value) {
    return escapeHtml(
      decodeEntities(value).replace(/<br\s*\/?>/gi, '\n')
    )
      .split('\n')
      .map(function (line) { return line.replace(/\s+/g, ' ').trim(); })
      .filter(function (line) { return line !== ''; })
      .join('\n');
  }

  /* "Vom rudimentären Unverständnis, 2012"
     → <em>Vom rudimentären Unverständnis</em>, 2012
     Only splits when the tail really is a year, so titles
     containing commas are left alone. */
  var YEAR_TAIL = /^\s*(?:c\.\s*|ca\.\s*|circa\s*)?\d{4}(?:\s*[–—-]\s*\d{2,4})?\s*$/;

  /* "65 x 50 cm", "2 x 8 x 10 inches", "11 × 14 in." */
  var DIMENSIONS = /\d\s*[x×]\s*\d|\b\d[\d.,]*\s*(?:cm|mm|in|in\.|inch|inches)\b/i;

  /* Deliberately narrow. Each of these would be a very strange
     thing for a whole title to be, which is what makes them safe
     to act on. A title like "Paper Moon" is untouched. */
  var MATERIAL = new RegExp(
    '\\b(?:' + [
      'gelatin\\s+silver',
      '(?:fibre|fiber|baryta|silver|pigment|inkjet|contact|platinum|palladium)\\s+print',
      'archival\\s+pigment',
      'chromogenic',
      'c-?print',
      'cibachrome',
      'giclee|gicl\\u00e9e',
      'polaroid',
      'screenprint|silkscreen|lithograph|photogravure|etching',
      /* the classic materials formula: "<medium> on <support>" */
      '(?:ink|oil|acrylic|gouache|graphite|charcoal|pastel|tempera|' +
        'pencil|watercolour|watercolor)\\s+on\\b'
    ].join('|') + ')',
    'i'
  );

  var NO_TITLE_MARK = /^[-–—‒]$/;

  /* A TRAILING PARENTHETICAL STAYS ROMAN, OUTSIDE THE ITALIC.
     "Die Gestolperte (The woman who stumbled), 2018"
       → <em>Die Gestolperte</em> (The woman who stumbled), 2018
     The bracket is a gloss on the title, not part of it, and the
     same treatment suits the other two things these brackets
     hold — a variant designator and a component. Note [^()]* —
     deliberately no nesting. */
  var TRAILING_GLOSS = /\s*(\([^()]*\))\s*$/;

  function endsInYear(line) {
    var cut = line.lastIndexOf(',');
    return cut > 0 && YEAR_TAIL.test(line.slice(cut + 1));
  }

  function looksLikeTitle(line) {
    if (endsInYear(line)) { return true; }          /* strongest signal */
    if (DIMENSIONS.test(line)) { return false; }
    if (MATERIAL.test(line)) { return false; }
    return true;                                     /* old behaviour */
  }

  function captionSourceFromText(text) {
    var raw = (text || '').split('\n')
      .map(function (l) { return l.trim(); });

    /* A blank or dashed FIRST line is the explicit "no title"
       mark. Read it before the blanks are dropped — that is the
       whole point of it. */
    var declaredUntitled =
      raw.length > 1 && (raw[0] === '' || NO_TITLE_MARK.test(raw[0]));

    var body = declaredUntitled ? raw.slice(1) : raw;

    /* CUT AT THE FIRST BLANK LINE. FooGallery concatenates
       Caption + Description into data-caption-title when the
       lightbox description override is off, joined by a blank
       line, so the credit line can arrive inside the caption.
       The real fix is the setting — FooGallery → the gallery →
       Lightbox → Override, Title = Attachment Caption,
       Description = Attachment Description. This is the floor so
       a stray Description can never reach a visitor. */
    var blank = body.findIndex(function (l) { return l === ''; });
    var kept  = blank > 0 ? body.slice(0, blank) : body;

    var lines = kept.filter(function (l) { return l !== ''; });
    if (!lines.length) { return null; }

    if (declaredUntitled || !looksLikeTitle(lines[0])) {
      return { title: '', detail: lines.join('\n') };
    }
    return { title: lines[0], detail: lines.slice(1).join('\n') };
  }

  function styleTitle(line) {
    var cut = line.lastIndexOf(',');
    if (cut > 0) {
      var tail = line.slice(cut + 1);
      if (YEAR_TAIL.test(tail)) {
        var head  = line.slice(0, cut).trim();
        var gloss = '';
        var m = TRAILING_GLOSS.exec(head);
        if (m && head.slice(0, m.index).trim() !== '') {
          gloss = ' ' + m[1];
          head  = head.slice(0, m.index).trim();
        }
        return '<em>' + head + '</em>' + gloss + ', ' + tail.trim();
      }
    }
    return line;
  }

  /* CAPTION      -> the dark block. Show title, work title and
                     year, "Installation view (detail)".
     DESCRIPTION  -> the grey block. Materials and size, or the
                     city and year on the home page.

     LEGACY: when there is no Description, fall back to the old
     single-field split (line 1 dark, rest grey) so nothing
     breaks before the library is migrated. That path disappears
     on its own as the caption sweep is applied. */
  function composeBlocks(darkText, greyText) {
    var dark = darkText;
    var grey = greyText;

    if (!grey) {
      var source = captionSourceFromText(darkText);
      if (!source) { return ''; }
      dark = source.title;
      grey = source.detail;
    }

    var html = '';

    if (dark) {
      /* Every line of the dark block gets the year test, not
         just the first — so a show title italicises and the
         "Installation view" under it does not. */
      var lines = dark.split('\n')
        .map(function (l) { return l.trim(); })
        .filter(function (l) { return l !== ''; })
        .map(styleTitle);
      if (lines.length) {
        html += '<span class="vy-cap-title">' + lines.join('<br>') + '</span>';
      }
    }

    if (grey) {
      html += '<span class="vy-cap-detail">' + grey + '</span>';
    }

    return html;
  }

  /* THE ONE ENTRY POINT. The gallery anchor is the source of
     truth for both surfaces — the lightbox and the grid — so
     they cannot drift, and nothing is ever read back out of a
     node we wrote. */
  function composeFromAnchor(anchor) {
    if (!anchor) { return ''; }
    return composeBlocks(
      toLines(anchor.getAttribute('data-caption-title') || ''),
      toLines(anchor.getAttribute('data-caption-desc')  || '')
    );
  }


  /* ==================================================
     ==================================================
     PART 2 — THE GRID THUMBNAILS' HOVER CAPTION
     ==================================================
     FooGallery drops the whole caption field into one
     .fg-caption-title div at white-space: normal, so
     title, material and size collapse onto one line in
     its own #333. We compose the same .vy-cap-* markup
     the lightbox uses, from the same anchor, so the
     thumbnail and the opened picture cannot disagree.
     ================================================== */
  function decorateGridCaptions() {
    var items = document.querySelectorAll('.fg-item');
    for (var i = 0; i < items.length; i++) {
      var target = items[i].querySelector('.fg-caption-title');
      if (!target || target.dataset.vyDone === '1') { continue; }

      var anchor = items[i].querySelector('a.fbx-link, a.fg-thumb');
      if (!anchor) { continue; }

      var html = composeFromAnchor(anchor);
      if (!html) { continue; }

      target.innerHTML = html;
      target.dataset.vyDone = '1';
    }
  }

  /* Masonry lays items out late and lazily, so run again
     whenever a gallery gains children. rAF-debounced, so a burst
     of insertions costs one pass. Scoped to the galleries — this
     is the only MutationObserver left in the file. */
  function watchGridCaptions() {
    var galleries = document.querySelectorAll('.foogallery');
    if (!galleries.length) { return; }

    var queued = false;
    var observer = new MutationObserver(function () {
      if (queued) { return; }
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        decorateGridCaptions();
        /* A new page of thumbnails means new captions, so the
           gallery's tallest one may have changed. */
        forgetReserve();
      });
    });

    for (var i = 0; i < galleries.length; i++) {
      observer.observe(galleries[i], { childList: true, subtree: true });
    }
  }


  /* ==================================================
     ==================================================
     PART 3 — THE VIEWER
     ==================================================
     ================================================== */

  var layers     = null;    /* [layerA, layerB]                */
  var active     = null;    /* the layer currently on screen   */
  var token      = 0;       /* supersedes an in-flight commit  */
  var captionOff = false;   /* the reader's choice; persists   */

  function getModal() {
    return document.querySelector('.fbx-modal');
  }

  function stackOf() {
    var modal = getModal();
    return modal ? modal.querySelector('.vy-stack') : null;
  }

  function buildLayer(stack) {
    var el = document.createElement('div');
    el.className = 'vy-layer';

    var frame = document.createElement('div');
    frame.className = 'vy-frame';

    var photo = document.createElement('img');
    photo.className = 'vy-photo';
    photo.alt = '';
    photo.decoding = 'async';
    photo.draggable = false;

    var caption = document.createElement('div');
    caption.className = 'vy-caption';
    /* role + tabindex make iOS treat this as a real control.
       Without them Safari often declines to synthesise a click
       on a plain <div> at all. */
    caption.setAttribute('role', 'button');
    caption.setAttribute('tabindex', '0');
    bindCaptionTap(caption);

    frame.appendChild(photo);
    frame.appendChild(caption);
    el.appendChild(frame);
    stack.appendChild(el);

    return { el: el, frame: frame, photo: photo, caption: caption };
  }

  function ensureViewer() {
    var modal = getModal();
    if (!modal) { return null; }

    var viewer = modal.querySelector('.vy-viewer');
    if (viewer) { return viewer; }

    viewer = document.createElement('div');
    viewer.className = 'vy-viewer';

    var stack = document.createElement('div');
    stack.className = 'vy-stack';
    viewer.appendChild(stack);
    modal.appendChild(viewer);

    layers = [buildLayer(stack), buildLayer(stack)];
    active = null;

    /* Firefox's mobile chrome is taller than Safari's, and the
       nav strip's height is what the stack's bottom inset is
       built from. A UA test, so it is done once here rather than
       on every slide as it used to be. */
    if (/FxiOS|Firefox/i.test(navigator.userAgent)) {
      modal.classList.add('fbx-mobile-firefox');
    }

    /* The stack derives from a fixed layer, so it resizes when
       mobile browser chrome appears or disappears, on rotation,
       and when the breakpoint swaps the nav strip in or out.
       Re-laying-out the visible layer is the only reaction
       needed. This one observer replaces the old resize
       listener, the orientationchange listener and
       forgetGalleryReserve(). */
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (active) { layout(active); }
      }).observe(stack);
    }

    /* Only now is it safe to stop FooBox painting. */
    modal.classList.add('vy-ready');

    return viewer;
  }


  /* --------------------------------------------------
     THE GALLERY'S ONE CAPTION RESERVE
     --------------------------------------------------
     Measured once per gallery per stack width, across
     every caption on the page, tallest wins. Cached; a
     change of width or of the item set retires it.
     -------------------------------------------------- */
  var reservePx = null;
  var reserveAt = 0;

  function forgetReserve() {
    reservePx = null;
    reserveAt = 0;
  }

  function measureReserve(stack) {
    var availW = stack.clientWidth;
    var availH = stack.clientHeight;
    if (!availW || !availH) { return 0; }
    if (reservePx !== null && reserveAt === availW) { return reservePx; }

    var probe = document.createElement('div');
    probe.className = 'vy-probe';
    probe.style.width = Math.round(availW * MEASURE_RATIO) + 'px';
    stack.appendChild(probe);

    /* Build every caption first, measure after — one layout for
       the whole set rather than one each. The probe's children
       carry the real .vy-caption class, so its padding and
       typography are included for free. */
    var anchors = document.querySelectorAll('a.fbx-link');
    var cells = [];
    for (var i = 0; i < anchors.length; i++) {
      var html = composeFromAnchor(anchors[i]);
      if (!html) { continue; }           /* uncaptioned items add nothing */
      var cell = document.createElement('div');
      cell.className = 'vy-caption';
      cell.innerHTML = html;
      probe.appendChild(cell);
      cells.push(cell);
    }

    var tallest = 0;
    for (var j = 0; j < cells.length; j++) {
      var h = cells[j].getBoundingClientRect().height;
      if (h > tallest) { tallest = h; }
    }

    stack.removeChild(probe);

    /* A gallery with no captions at all reserves nothing, and
       the photograph gets the whole box. */
    reservePx = tallest
      ? Math.round(Math.min(tallest + RESERVE_PAD, availH * RESERVE_MAX_SHARE))
      : 0;
    reserveAt = availW;
    return reservePx;
  }


  /* --------------------------------------------------
     LAYOUT
     --------------------------------------------------
     stack.clientWidth / clientHeight ARE the available
     box: the CSS insets have already removed the
     gutters, the nav strip and the safe areas. No
     viewport arithmetic anywhere — no vh, no svh, no
     visualViewport.

     Only ONE inline style is written per slide: the
     frame's width. The photograph is width:100% of the
     frame and the caption is width:100% of the frame, so
     the caption is exactly the picture's width — it can
     never overhang it — and the picture's height follows
     from its own aspect ratio.

     Two custom properties go out to the CSS:
       --vy-reserve  the caption card's max-height
       --vy-band     the photograph's max-height, and on
                     desktop the arrows' centre
     -------------------------------------------------- */
  function layout(layer) {
    var stack = stackOf();
    var modal = getModal();
    if (!stack || !modal || !layer) { return; }

    var photo = layer.photo;
    if (!photo.naturalWidth || !photo.naturalHeight) { return; }

    var availW = stack.clientWidth;
    var availH = stack.clientHeight;
    if (availW <= 0 || availH <= 0) { return; }

    var ratio  = photo.naturalWidth / photo.naturalHeight;
    var styles = getComputedStyle(layer.frame);
    var gap    = parseFloat(styles.rowGap || styles.gap) || 0;
    var hasCaption = !layer.caption.classList.contains('vy-cap-empty');

    var band;
    var width;

    if (!mobile.matches) {
      /* DESKTOP — one constant band for the whole gallery. */
      var reserve = measureReserve(stack);
      band  = Math.max(MIN_BAND, availH - reserve - (reserve ? gap : 0));
      width = Math.min(band * ratio, availW);

      /* "none" rather than "0px" when the gallery has no
         captions at all, so the max-height can never clamp a
         card to nothing. */
      modal.style.setProperty(
        '--vy-reserve', reserve ? reserve + 'px' : 'none'
      );
      modal.style.setProperty('--vy-band', Math.round(band) + 'px');
      layer.frame.style.width = Math.round(width) + 'px';
      return;
    }

    /* MOBILE — fit this caption to this picture. The ceiling is
       set BEFORE anything is measured; that is what stops the
       spiral. */
    modal.style.setProperty(
      '--vy-reserve',
      Math.round(availH * CAPTION_MAX_SHARE_MOBILE) + 'px'
    );

    band  = availH;
    width = availW;

    for (var pass = 0; pass < FIT_PASSES; pass++) {
      layer.frame.style.width = Math.round(width) + 'px';
      var capH = hasCaption
        ? layer.caption.getBoundingClientRect().height
        : 0;
      band  = Math.max(MIN_BAND, availH - capH - (capH ? gap : 0));
      width = Math.min(band * ratio, availW);
    }

    modal.style.setProperty('--vy-band', Math.round(band) + 'px');
    layer.frame.style.width = Math.round(width) + 'px';
  }


  /* --------------------------------------------------
     COMMIT — build the next slide invisibly, then swap
     -------------------------------------------------- */
  function idleLayer() {
    if (!layers) { return null; }
    return layers[0] === active ? layers[1] : layers[0];
  }

  function decoded(photo) {
    if (typeof photo.decode === 'function') {
      return photo.decode();
    }
    /* Pre-2019 Safari. */
    return new Promise(function (resolve, reject) {
      if (photo.complete && photo.naturalWidth) { resolve(); return; }
      photo.addEventListener('load',  function () { resolve(); }, { once: true });
      photo.addEventListener('error', function () { reject();  }, { once: true });
    });
  }

  function commit(item) {
    if (!ensureViewer() || !item || !item.url) { return; }

    var mine  = ++token;
    var layer = idleLayer();
    var anchor = item.element && item.element.jquery
      ? item.element.get(0)
      : item.element;

    layer.caption.innerHTML = composeFromAnchor(anchor);
    layer.caption.classList.toggle(
      'vy-cap-empty', layer.caption.textContent.trim() === ''
    );
    layer.caption.classList.toggle('vy-cap-hidden', captionOff);

    var ready;
    if (layer.photo.getAttribute('src') === item.url) {
      ready = Promise.resolve();
    } else {
      layer.photo.src = item.url;
      ready = decoded(layer.photo);
    }

    ready.then(function () {
      if (mine !== token) { return; }          /* superseded */
      layout(layer);
      /* One frame, so the new geometry is painted into the layer
         while it is still invisible. */
      requestAnimationFrame(function () {
        if (mine !== token) { return; }
        show(layer);
      });
    })['catch'](function () { /* a failed image simply never shows */ });
  }

  /* The swap is a HARD CUT, deliberately. Dissolving two stacked
     images means neither is fully opaque in the middle of the
     dissolve, so the translucent ground lets the page show
     through — the exact artefact this rewrite removes. Both
     layers are fully decoded and laid out before the swap, so an
     instant cut has no blank frame, no ghosting and nothing to
     tune. */
  function show(layer) {
    for (var i = 0; i < layers.length; i++) {
      layers[i].el.classList.toggle('is-active', layers[i] === layer);
    }
    active = layer;
  }


  /* ==================================================
     ==================================================
     PART 4 — THE CAPTION TAP
     ==================================================
     Bound DIRECTLY ON THE CAPTION, bubble phase.

     Two earlier approaches failed and must not come back:

       - a click listener, while our layer sat BELOW
         FooBox's opacity-0-but-hit-testable stage, so the
         tap landed on img.fbx-item-image and our own
         close-on-tap branch closed the lightbox. Fixed in
         CSS: .vy-viewer sits above .fbx-inner's 100002.

       - a window/capture listener calling
         stopPropagation(): per the DOM spec that halts
         the event before it reaches the target, so
         nothing bound on the caption could fire at all.

     pointerup fires on the element, for mouse and touch
     alike, before touchend and the compatibility mouse
     events. ONE binding now serves both breakpoints —
     desktop no longer needs a separate click path.
     ================================================== */
  function applyCaptionVisibility() {
    if (!layers) { return; }
    for (var i = 0; i < layers.length; i++) {
      layers[i].caption.classList.toggle('vy-cap-hidden', captionOff);
    }
  }

  function toggleCaption() {
    captionOff = !captionOff;
    applyCaptionVisibility();
  }

  function bindCaptionTap(caption) {
    var downX = 0;
    var downY = 0;
    var moved = false;

    caption.addEventListener('pointerdown', function (e) {
      downX = e.clientX; downY = e.clientY; moved = false;
    });
    caption.addEventListener('pointermove', function (e) {
      if (Math.abs(e.clientX - downX) > 10 ||
          Math.abs(e.clientY - downY) > 10) { moved = true; }
    });
    caption.addEventListener('pointerup', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (moved) { moved = false; return; }
      toggleCaption();
    });

    /* The synthetic click that follows a tap must not reach
       FooBox or our own close-on-tap handler. Element listeners
       are not passive by default, so preventDefault works here. */
    caption.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
    });

    caption.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        toggleCaption();
      }
    });
  }


  /* ==================================================
     ==================================================
     PART 5 — CLOSE ON TAP (MOBILE ONLY)
     ==================================================
     Desktop keeps FooBox's own behaviour: Escape, and a
     click on the modal background.
     ================================================== */
  var pointerStartX = 0;
  var pointerStartY = 0;
  var pointerMoved  = false;

  window.addEventListener('pointerdown', function (e) {
    if (!mobile.matches || !getModal()) { return; }
    pointerStartX = e.clientX;
    pointerStartY = e.clientY;
    pointerMoved = false;
  }, true);

  window.addEventListener('pointermove', function (e) {
    if (!mobile.matches || !getModal()) { return; }
    if (Math.abs(e.clientX - pointerStartX) > 12 ||
        Math.abs(e.clientY - pointerStartY) > 12) {
      pointerMoved = true;
    }
  }, true);

  document.addEventListener('click', function (e) {
    if (!mobile.matches) { return; }

    var target = e.target instanceof Element ? e.target : null;
    if (!target) { return; }

    var modal = getModal();
    if (!modal || !modal.classList.contains('fbx-show')) { return; }

    if (target.closest('.fbx-close')) { return; }
    if (target.closest('.vy-caption')) { return; }

    /* Native FooBox navigation — hands off. */
    if (target.closest('.fbx-prev, .fbx-next')) {
      pointerMoved = false;
      return;
    }

    /* Native swipe. */
    if (pointerMoved) { pointerMoved = false; return; }

    if (modal.contains(target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      /* .fbx-close is display:none but still accepts a
         programmatic click, which is why it stays in the DOM. */
      var button = modal.querySelector('button.fbx-close');
      if (button) { button.click(); }
    }
  }, true);


  /* ==================================================
     ==================================================
     PART 6 — WIRE UP TO FOOBOX
     ==================================================
     ================================================== */

  /* FooBox's own speeds. Its stage is invisible now, so these no
     longer affect anything that is seen — but the instance holds
     _busy for the whole of its animation chain, and that is what
     gates how fast a visitor can click through. At zero the
     chain completes in about a frame.

     preload is the one that still does real work: it is FooBox's
     own next/previous prefetch, and it is what makes our
     decode() resolve instantly instead of paying a network round
     trip on her 150KB–950KB files. It ships OFF by default. */
  var FBX_SPEEDS = {
    transitionInSpeed:  0,
    transitionOutSpeed: 0,
    resizeSpeed:        0,
    resizeTimeout:      0,
    preload:            true
  };

  function bindInstance(node) {
    var $node = window.jQuery(node);
    var instance = $node.data('fbx_instance');
    if (!instance || !instance.options) { return false; }

    var key;
    for (key in FBX_SPEEDS) { instance.options[key] = FBX_SPEEDS[key]; }

    /* THE WHOLE SYNCHRONISATION LAYER, IN FOUR LINES.
       beforeLoad carries the item that is about to load — its
       url and its gallery anchor — so the next slide is built
       before FooBox has touched the screen. Fires on open as
       well as on navigation. */
    $node.on('foobox.beforeLoad', function (e) {
      if (e.fb && e.fb.item) { commit(e.fb.item); }
    });

    /* A different gallery, or a re-initialised one, may have
       different captions. */
    $node.on('foobox.reinitialized', forgetReserve);

    node.dataset.vyBound = '1';
    return true;
  }

  function bindAll() {
    if (!window.jQuery) { return 0; }

    /* Also on the defaults, so an instance created later is born
       with them rather than needing to be caught. */
    if (window.FOOBOX && window.FOOBOX.o) {
      var key;
      for (key in FBX_SPEEDS) { window.FOOBOX.o[key] = FBX_SPEEDS[key]; }
    }

    var bound = 0;
    var nodes = document.querySelectorAll('.fbx-instance');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].dataset.vyBound === '1') { continue; }
      if (bindInstance(nodes[i])) { bound++; }
    }
    return bound;
  }

  /* FooGallery builds its FooBox instance after this file runs,
     so poll briefly rather than assuming it is there. Stops as
     soon as one is bound, and gives up after 6s rather than
     polling forever. This is the only interval in the file and
     it does not survive startup. */
  function bindWhenReady() {
    if (bindAll() > 0) { return; }
    var tries = 0;
    var timer = setInterval(function () {
      if (bindAll() > 0 || ++tries > 30) { clearInterval(timer); }
    }, 200);
  }


  /* ==================================================
     INITIALISE
     ================================================== */
  decorateGridCaptions();
  watchGridCaptions();
  bindWhenReady();

  console.log('FooBox custom lightbox JS loaded:', VERSION);
})();