import type * as hast from 'hast';
import type * as mdast from 'mdast';
import type {
	one as Handler,
	all as Handlers,
	Options as RemarkRehypeOptions,
} from 'remark-rehype';
import type { ILanguageRegistration, IThemeRegistration, Theme } from 'shiki';
import type * as unified from 'unified';
import type { VFile } from 'vfile';

export type { Node } from 'unist';

export type MarkdownAstroData = {
	frontmatter: Record<string, any>;
};

export type RemarkPlugin<PluginParameters extends any[] = any[]> = unified.Plugin<
	PluginParameters,
	mdast.Root
>;

export type RemarkPlugins = (string | [string, any] | RemarkPlugin | [RemarkPlugin, any])[];

export type RehypePlugin<PluginParameters extends any[] = any[]> = unified.Plugin<
	PluginParameters,
	hast.Root
>;

export type RehypePlugins = (string | [string, any] | RehypePlugin | [RehypePlugin, any])[];

export type RemarkRehype = Omit<RemarkRehypeOptions, 'handlers' | 'unknownHandler'> & {
	handlers?: typeof Handlers;
	handler?: typeof Handler;
};

export interface ShikiConfig {
	langs?: ILanguageRegistration[];
	theme?: Theme | IThemeRegistration;
	wrap?: boolean | null;
}

export interface AstroMarkdownOptions {
	drafts?: boolean;
	syntaxHighlight?: 'shiki' | 'prism' | false;
	shikiConfig?: ShikiConfig;
	remarkPlugins?: RemarkPlugins;
	rehypePlugins?: RehypePlugins;
	remarkRehype?: RemarkRehype;
	gfm?: boolean;
	smartypants?: boolean;
}

export interface ImageMetadata {
	src: string;
	width: number;
	height: number;
	type: string;
}

export interface MarkdownProcessor {
	render: (
		content: string,
		opts?: MarkdownProcessorRenderOptions
	) => Promise<MarkdownProcessorRenderResult>;
}

export interface MarkdownProcessorRenderOptions {
	/** @internal */
	fileURL?: URL;
	/** Used for frontmatter injection plugins */
	frontmatter?: Record<string, any>;
}

export interface MarkdownProcessorRenderResult {
	code: string;
	metadata: {
		headings: MarkdownHeading[];
		imagePaths: Set<string>;
		frontmatter: Record<string, any>;
	};
}

export interface MarkdownRenderingOptions
	extends AstroMarkdownOptions,
		MarkdownProcessorRenderOptions {}

export interface MarkdownHeading {
	depth: number;
	slug: string;
	text: string;
}

export interface MarkdownMetadata {
	headings: MarkdownHeading[];
	source: string;
	html: string;
}

export interface MarkdownVFile extends VFile {
	data: {
		__astroHeadings?: MarkdownHeading[];
		imagePaths?: Set<string>;
	};
}

export interface MarkdownRenderingResult {
	metadata: MarkdownMetadata;
	vfile: MarkdownVFile;
	code: string;
}
