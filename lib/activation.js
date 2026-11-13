/**
 * Adapt the public activation envelope across the nested and flat host APIs.
 * The named-tree methods were introduced with the verified flat API; checking
 * them avoids version guesses and speculative starts that could create twice.
 */

/** @returns whether this service exposes the verified flat activation API. */
export function usesFlatActivationSpec(service) {
    return typeof service?.namesOf === 'function'
        && typeof service?.resolveName === 'function'
        && typeof service?.listDescendants === 'function';
}

/**
 * Start one activation from the legacy { provider, request, signal, delivery }
 * envelope. Keep the exact parent, options, prompt, signal, and native return.
 * Outer activation fields retain their precedence when request is flattened.
 * Native synchronous errors and rejected promises propagate without retry.
 *
 * @param service - host subagent service, used as the method receiver.
 * @param legacySpec - activation envelope with a nested request.
 * @returns the host's unmodified activation return value.
 */
export function startCompatibleActivation(service, legacySpec) {
    if (!usesFlatActivationSpec(service))
        return service.startActivation(legacySpec);
    const { request, ...spec } = legacySpec;
    return service.startActivation({ ...request, ...spec });
}
