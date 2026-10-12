// Astro integration: registers the metadata-preserving image service.
//
//   import aiDisclosure from '@jehu/astro-ai-disclosure';
//   export default defineConfig({ integrations: [aiDisclosure()] });

import type { AstroIntegration } from 'astro';
import type { SharpImageServiceConfig } from 'astro/assets/services/sharp';

export interface AiDisclosureOptions {
  /** Options forwarded to the underlying Sharp service (`limitInputPixels`, encoder defaults, …). */
  sharp?: SharpImageServiceConfig;
}

export default function aiDisclosure(options: AiDisclosureOptions = {}): AstroIntegration {
  return {
    name: '@jehu/astro-ai-disclosure',
    hooks: {
      'astro:config:setup'({ config, updateConfig }) {
        const entrypoint = config.image.service.entrypoint;
        if (entrypoint !== 'astro/assets/services/sharp' && entrypoint !== '@jehu/astro-ai-disclosure/image-service') {
          throw new Error(
            `[@jehu/astro-ai-disclosure] Cannot replace image service "${entrypoint}". ` +
              'Remove the custom image.service configuration or use the disclosure APIs without the integration.',
          );
        }
        updateConfig({
          image: {
            service: {
              entrypoint: '@jehu/astro-ai-disclosure/image-service',
              config: options.sharp ?? {},
            },
          },
        });
      },
    },
  };
}

export { readC2paManifest, hasC2paManifest, isAiSourceType, type C2paInfo } from './c2pa.js';
export { readXmpCredentials, tagAiImage, TRAINED_ALGORITHMIC_MEDIA, type TagOptions, type TagResult, type XmpCredentials } from './xmp.js';
export {
  readAiCredentialsFromBuffer,
  readAiCredentialsFromFile,
  createCredentialReader,
  assertAiDisclosure,
  formatCreatedAt,
  type AiCredentials,
} from './credentials.js';
