export type Fallback = 'none' | 'animate' | 'swap';
export type Direction = 'forward' | 'back';
export type Options = { history?: 'auto' | 'push' | 'replace' };

type State = {
	index: number;
	scrollX: number;
	scrollY: number;
	intraPage?: boolean;
};
type Events = 'astro:page-load' | 'astro:after-swap';

// only update history entries that are managed by us
// leave other entries alone and do not accidently add state.
const persistState = (state: State) => history.state && history.replaceState(state, '');
export const supportsViewTransitions = !!document.startViewTransition;
export const transitionEnabledOnThisPage = () =>
	!!document.querySelector('[name="astro-view-transitions-enabled"]');
const samePage = (otherLocation: URL) =>
	location.pathname === otherLocation.pathname && location.search === otherLocation.search;
const triggerEvent = (name: Events) => document.dispatchEvent(new Event(name));
const onPageLoad = () => triggerEvent('astro:page-load');
const announce = () => {
	let div = document.createElement('div');
	div.setAttribute('aria-live', 'assertive');
	div.setAttribute('aria-atomic', 'true');
	div.setAttribute(
		'style',
		'position:absolute;left:0;top:0;clip:rect(0 0 0 0);clip-path:inset(50%);overflow:hidden;white-space:nowrap;width:1px;height:1px'
	);
	document.body.append(div);
	setTimeout(
		() => {
			let title = document.title || document.querySelector('h1')?.textContent || location.pathname;
			div.textContent = title;
		},
		// Much thought went into this magic number; the gist is that screen readers
		// need to see that the element changed and might not do so if it happens
		// too quickly.
		60
	);
};
const PERSIST_ATTR = 'data-astro-transition-persist';
const parser = new DOMParser();
// explained at its usage
let noopEl: HTMLDivElement;
if (import.meta.env.DEV) {
	noopEl = document.createElement('div');
}

// The History API does not tell you if navigation is forward or back, so
// you can figure it using an index. On pushState the index is incremented so you
// can use that to determine popstate if going forward or back.
let currentHistoryIndex = 0;
if (history.state) {
	// we reloaded a page with history state
	// (e.g. history navigation from non-transition page or browser reload)
	currentHistoryIndex = history.state.index;
	scrollTo({ left: history.state.scrollX, top: history.state.scrollY });
} else if (transitionEnabledOnThisPage()) {
	history.replaceState({ index: currentHistoryIndex, scrollX, scrollY, intraPage: false }, '');
}
const throttle = (cb: (...args: any[]) => any, delay: number) => {
	let wait = false;
	// During the waiting time additional events are lost.
	// So repeat the callback at the end if we have swallowed events.
	let onceMore = false;
	return (...args: any[]) => {
		if (wait) {
			onceMore = true;
			return;
		}
		cb(...args);
		wait = true;
		setTimeout(() => {
			if (onceMore) {
				onceMore = false;
				cb(...args);
			}
			wait = false;
		}, delay);
	};
};

// returns the contents of the page or null if the router can't deal with it.
async function fetchHTML(
	href: string
): Promise<null | { html: string; redirected?: string; mediaType: DOMParserSupportedType }> {
	try {
		const res = await fetch(href);
		// drop potential charset (+ other name/value pairs) as parser needs the mediaType
		const mediaType = res.headers.get('content-type')?.replace(/;.*$/, '');
		// the DOMParser can handle two types of HTML
		if (mediaType !== 'text/html' && mediaType !== 'application/xhtml+xml') {
			// everything else (e.g. audio/mp3) will be handled by the browser but not by us
			return null;
		}
		const html = await res.text();
		return {
			html,
			redirected: res.redirected ? res.url : undefined,
			mediaType,
		};
	} catch (err) {
		// can't fetch, let someone else deal with it.
		return null;
	}
}

function getFallback(): Fallback {
	const el = document.querySelector('[name="astro-view-transitions-fallback"]');
	if (el) {
		return el.getAttribute('content') as Fallback;
	}
	return 'animate';
}

function markScriptsExec() {
	for (const script of document.scripts) {
		script.dataset.astroExec = '';
	}
}

function runScripts() {
	let wait = Promise.resolve();
	for (const script of Array.from(document.scripts)) {
		if (script.dataset.astroExec === '') continue;
		const newScript = document.createElement('script');
		newScript.innerHTML = script.innerHTML;
		for (const attr of script.attributes) {
			if (attr.name === 'src') {
				const p = new Promise((r) => {
					newScript.onload = r;
				});
				wait = wait.then(() => p as any);
			}
			newScript.setAttribute(attr.name, attr.value);
		}
		newScript.dataset.astroExec = '';
		script.replaceWith(newScript);
	}
	return wait;
}

function isInfinite(animation: Animation) {
	const effect = animation.effect;
	if (!effect || !(effect instanceof KeyframeEffect) || !effect.target) return false;
	const style = window.getComputedStyle(effect.target, effect.pseudoElement);
	return style.animationIterationCount === 'infinite';
}

const updateHistoryAndScrollPosition = (toLocation: URL, replace: boolean, intraPage: boolean) => {
	const fresh = !samePage(toLocation);
	if (toLocation.href !== location.href) {
		if (replace) {
			history.replaceState({ ...history.state }, '', toLocation.href);
		} else {
			history.replaceState({ ...history.state, intraPage }, '');
			history.pushState({ index: ++currentHistoryIndex, scrollX, scrollY }, '', toLocation.href);
		}
		// now we are on the new page for non-history navigations!
		// (with history navigation page change happens before popstate is fired)
		// freshly loaded pages start from the top
		if (fresh) {
			scrollTo({ left: 0, top: 0, behavior: 'instant' });
		}
	}
	if (toLocation.hash) {
		// because we are already on the target page ...
		// ... what comes next is a intra-page navigation
		// that won't reload the page but instead scroll to the fragment
		location.href = toLocation.href;
	} else {
		scrollTo({ left: 0, top: 0, behavior: 'instant' });
	}
};

// replace head and body of the windows document with contents from newDocument
// if !popstate, update the history entry and scroll position according to toLocation
// if popState is given, this holds the scroll position for history navigation
// if fallback === "animate" then simulate view transitions
async function updateDOM(
	newDocument: Document,
	toLocation: URL,
	options: Options,
	popState?: State,
	fallback?: Fallback
) {
	// Check for a head element that should persist and returns it,
	// either because it has the data attribute or is a link el.
	const persistedHeadElement = (el: HTMLElement): Element | null => {
		const id = el.getAttribute(PERSIST_ATTR);
		const newEl = id && newDocument.head.querySelector(`[${PERSIST_ATTR}="${id}"]`);
		if (newEl) {
			return newEl;
		}
		if (el.matches('link[rel=stylesheet]')) {
			const href = el.getAttribute('href');
			return newDocument.head.querySelector(`link[rel=stylesheet][href="${href}"]`);
		}
		// What follows is a fix for an issue (#8472) with missing client:only styles after transition.
		// That problem exists only in dev mode where styles are injected into the page by Vite.
		// Returning a noop element ensures that the styles are not removed from the old document.
		// Guarding the code below with the dev mode check
		// allows tree shaking to remove this code in production.
		if (import.meta.env.DEV) {
			if (el.tagName === 'STYLE' && el.dataset.viteDevId) {
				const devId = el.dataset.viteDevId;
				// If this same style tag exists, remove it from the new page
				return (
					newDocument.querySelector(`style[data-vite-dev-id="${devId}"]`) ||
					// Otherwise, keep it anyways. This is client:only styles.
					noopEl
				);
			}
		}
		return null;
	};

	const swap = () => {
		// swap attributes of the html element
		// - delete all attributes from the current document
		// - insert all attributes from doc
		// - reinsert all original attributes that are named 'data-astro-*'
		const html = document.documentElement;
		const astro = [...html.attributes].filter(
			({ name }) => (html.removeAttribute(name), name.startsWith('data-astro-'))
		);
		[...newDocument.documentElement.attributes, ...astro].forEach(({ name, value }) =>
			html.setAttribute(name, value)
		);

		// Replace scripts in both the head and body.
		for (const s1 of document.scripts) {
			for (const s2 of newDocument.scripts) {
				if (
					// Inline
					(!s1.src && s1.textContent === s2.textContent) ||
					// External
					(s1.src && s1.type === s2.type && s1.src === s2.src)
				) {
					// the old script is in the new document: we mark it as executed to prevent re-execution
					s2.dataset.astroExec = '';
					break;
				}
			}
		}

		// Swap head
		for (const el of Array.from(document.head.children)) {
			const newEl = persistedHeadElement(el as HTMLElement);
			// If the element exists in the document already, remove it
			// from the new document and leave the current node alone
			if (newEl) {
				newEl.remove();
			} else {
				// Otherwise remove the element in the head. It doesn't exist in the new page.
				el.remove();
			}
		}

		// Everything left in the new head is new, append it all.
		document.head.append(...newDocument.head.children);

		// Persist elements in the existing body
		const oldBody = document.body;

		// this will reset scroll Position
		document.body.replaceWith(newDocument.body);
		for (const el of oldBody.querySelectorAll(`[${PERSIST_ATTR}]`)) {
			const id = el.getAttribute(PERSIST_ATTR);
			const newEl = document.querySelector(`[${PERSIST_ATTR}="${id}"]`);
			if (newEl) {
				// The element exists in the new page, replace it with the element
				// from the old page so that state is preserved.
				newEl.replaceWith(el);
			}
		}

		if (popState) {
			scrollTo(popState.scrollX, popState.scrollY); // usings 'auto' scrollBehavior
		} else {
			updateHistoryAndScrollPosition(toLocation, options.history === 'replace', false);
		}

		triggerEvent('astro:after-swap');
	};

	// Wait on links to finish, to prevent FOUC
	const links: Promise<any>[] = [];
	for (const el of newDocument.querySelectorAll('head link[rel=stylesheet]')) {
		// Do not preload links that are already on the page.
		if (
			!document.querySelector(
				`[${PERSIST_ATTR}="${el.getAttribute(PERSIST_ATTR)}"], link[rel=stylesheet]`
			)
		) {
			const c = document.createElement('link');
			c.setAttribute('rel', 'preload');
			c.setAttribute('as', 'style');
			c.setAttribute('href', el.getAttribute('href')!);
			links.push(
				new Promise<any>((resolve) => {
					['load', 'error'].forEach((evName) => c.addEventListener(evName, resolve));
					document.head.append(c);
				})
			);
		}
	}
	links.length && (await Promise.all(links));

	if (fallback === 'animate') {
		// Trigger the animations
		const currentAnimations = document.getAnimations();
		document.documentElement.dataset.astroTransitionFallback = 'old';
		const newAnimations = document
			.getAnimations()
			.filter((a) => !currentAnimations.includes(a) && !isInfinite(a));
		const finished = Promise.all(newAnimations.map((a) => a.finished));
		const fallbackSwap = () => {
			swap();
			document.documentElement.dataset.astroTransitionFallback = 'new';
		};
		await finished;
		fallbackSwap();
	} else {
		swap();
	}
}

async function transition(
	direction: Direction,
	toLocation: URL,
	options: Options,
	popState?: State
) {
	let finished: Promise<void>;
	const href = toLocation.href;
	const response = await fetchHTML(href);
	// If there is a problem fetching the new page, just do an MPA navigation to it.
	if (response === null) {
		location.href = href;
		return;
	}
	// if there was a redirection, show the final URL in the browser's address bar
	if (response.redirected) {
		toLocation = new URL(response.redirected);
	}

	const newDocument = parser.parseFromString(response.html, response.mediaType);
	// The next line might look like a hack,
	// but it is actually necessary as noscript elements
	// and their contents are returned as markup by the parser,
	// see https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString
	newDocument.querySelectorAll('noscript').forEach((el) => el.remove());

	if (!newDocument.querySelector('[name="astro-view-transitions-enabled"]')) {
		location.href = href;
		return;
	}

	if (!popState) {
		// save the current scroll position before we change the DOM and transition to the new page
		history.replaceState({ ...history.state, scrollX, scrollY }, '');
	}
	document.documentElement.dataset.astroTransition = direction;
	if (supportsViewTransitions) {
		finished = document.startViewTransition(() =>
			updateDOM(newDocument, toLocation, options, popState)
		).finished;
	} else {
		finished = updateDOM(newDocument, toLocation, options, popState, getFallback());
	}
	try {
		await finished;
	} finally {
		// skip this for the moment as it tends to stop fallback animations
		// document.documentElement.removeAttribute('data-astro-transition');
		await runScripts();
		markScriptsExec();
		onPageLoad();
		announce();
	}
}

export function navigate(href: string, options?: Options) {
	// not ours
	if (!transitionEnabledOnThisPage()) {
		location.href = href;
		return;
	}
	const toLocation = new URL(href, location.href);
	// We do not have page transitions on navigations to the same page (intra-page navigation)
	// but we want to handle prevent reload on navigation to the same page
	// Same page means same origin, path and query params (but maybe different hash)
	if (location.origin === toLocation.origin && samePage(toLocation)) {
		updateHistoryAndScrollPosition(toLocation, options?.history === 'replace', true);
	} else {
		// different origin will be detected by fetch
		transition('forward', toLocation, options ?? {});
	}
}

if (supportsViewTransitions || getFallback() !== 'none') {
	addEventListener('popstate', (ev) => {
		if (!transitionEnabledOnThisPage() && ev.state) {
			// The current page doesn't have View Transitions enabled
			// but the page we navigate to does (because it set the state).
			// Do a full page refresh to reload the client-side router from the new page.
			// Scroll restauration will then happen during the reload when the router's code is re-executed
			if (history.scrollRestoration) {
				history.scrollRestoration = 'manual';
			}
			location.reload();
			return;
		}

		// History entries without state are created by the browser (e.g. for hash links)
		// Our view transition entries always have state.
		// Just ignore stateless entries.
		// The browser will handle navigation fine without our help
		if (ev.state === null) {
			if (history.scrollRestoration) {
				history.scrollRestoration = 'auto';
			}
			return;
		}

		// With the default "auto", the browser will jump to the old scroll position
		// before the ViewTransition is complete.
		if (history.scrollRestoration) {
			history.scrollRestoration = 'manual';
		}

		const state: State = history.state;
		if (state.intraPage) {
			// this is non transition intra-page scrolling
			scrollTo(state.scrollX, state.scrollY);
		} else {
			const nextIndex = state.index;
			const direction: Direction = nextIndex > currentHistoryIndex ? 'forward' : 'back';
			currentHistoryIndex = nextIndex;
			transition(direction, new URL(location.href), {}, state);
		}
	});

	addEventListener('load', onPageLoad);
	// There's not a good way to record scroll position before a back button.
	// So the way we do it is by listening to scrollend if supported, and if not continuously record the scroll position.
	const updateState = () => {
		persistState({ ...history.state, scrollX, scrollY });
	};

	if ('onscrollend' in window) addEventListener('scrollend', updateState);
	else addEventListener('scroll', throttle(updateState, 300));

	markScriptsExec();
}
