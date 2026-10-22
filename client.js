/**
 * The dkitchen section on this bundle's page in Plugins.
 *
 * In the Python era this page told the user to run `pip install dkitchen` and `ding plugin
 * install`, because the bundle was only a shim that spawned an MCP server. None of that
 * applies now: the tools are registered in-process, so installing the bundle *is* the
 * installation. What a user still needs to know is per-repository — every call reports the
 * repo it resolved, so a kitchen configured in one checkout and used from another shows the
 * mismatch in that repo rather than seeming to do nothing at all.
 *
 * It renders into `plugins.detail.section`, the slot a plugin uses for something to say about
 * a bundle, rather than `plugins.bundle.config`, which is a settings form: nothing here is
 * editable. The facts come from the page's `subject`, because `subject.pkg` carries the bundle
 * name, version, and installed/enabled state the Host already read.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dkitchen',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const styles = {
      table: {
        display: 'grid',
        gridTemplateColumns: 'max-content 1fr',
        columnGap: 16,
        rowGap: 8,
        alignItems: 'baseline',
        margin: 0,
      },
      label: { opacity: 0.72 },
      code: {
        display: 'block',
        marginTop: 4,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.92em',
        opacity: 0.9,
        userSelect: 'all',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      ok: { opacity: 0.72 },
      missing: { fontWeight: 600 },
      note: { opacity: 0.72, marginTop: 12, marginBottom: 0 },
    };

    /** One fact: what it is, its state, and the command that supplies it when missing. */
    function Row({ label, value, command, ok }) {
      return [
        h('dt', { key: 'l', style: styles.label }, label),
        h('dd', { key: 'v', style: { margin: 0 } },
          h('span', { style: ok ? styles.ok : styles.missing }, value),
          command ? h('code', { style: styles.code }, command) : null),
      ];
    }

    function Section({ pkg, t }) {
      if (!pkg) return null;
      const installed = Boolean(pkg.installed);
      const enabled = Boolean(pkg.enabled);
      return h('div', null,
        h('dl', { style: styles.table },
          h(Row, {
            label: t('labelBundle'),
            value: installed ? pkg.version : t('notInstalled'),
            command: installed ? null : 'install this bundle from the Plugins page',
            ok: installed,
          }),
          h(Row, {
            label: t('labelEnabled'),
            value: enabled ? t('yes') : t('no'),
            command: enabled ? null : 'switch it on from this page',
            ok: enabled,
          })),
        h('p', { style: styles.note }, t('setupNote')),
        h('code', { style: styles.code }, t('setupConfig')),
        h('p', { style: styles.note }, t('setupStatus')));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dkitchen-setup',
          order: 20,
          locale: 'dsh-dkitchen',
        }, ({ t, subject }) => {
          if (!subject || subject.kind !== 'bundle' || subject.pkg.name !== 'dsh-dkitchen') {
            return null;
          }
          return h(Section, { pkg: subject.pkg, t });
        }));
      },
    };
  },
});
