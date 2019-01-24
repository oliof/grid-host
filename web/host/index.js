let lastT = null;
let lastQ = null;

function $(id) {
    return document.getElementById(id);
}

function targets(t) {
    lastT = Object.assign({}, t);
    let html = [
        '<table><thead><tr>',
        cell('th', div('target')),
        cell('th', div('info')),
        cell('th', div('status')),
        cell('th', div('%')),
        cell('th', div('nozzle 0')),
        cell('th', div('nozzle 1')),
        cell('th', div('bed')),
        cell('th', div('action')),
        '</tr></thead><tbody>'
    ];
    for (let k in t) {
        if (t.hasOwnProperty(k)) {
            let v = t[k];
            let stat = v.status;
            html.push(`<tr id="device-${k}">`);
            html.push(cell('th', k));
            html.push(cell('td', v.comment || ''));
            if (stat) {
                html.push(cell('td', stat.state || '-'));
                html.push(cell('td', `${stat.progress || 0}%`));
                if (stat.temps && stat.temps.T0) {
                    html.push(cell('td', stat.temps.T0.join(' / ')));
                } else {
                    html.push(cell('td', '-'));
                }
                if (stat.temps && stat.temps.T1) {
                    html.push(cell('td', stat.temps.T1.join(' / ')));
                } else {
                    html.push(cell('td', '-'));
                }
                if (stat.temps && stat.temps.B) {
                    html.push(cell('td', stat.temps.B.join(' / ')));
                } else {
                    html.push(cell('td', '-'));
                }
                html.push(cell('td', 'cancel', {onclick: `print_cancel('${k}')`}));
            }
            html.push('</tr>');
        }
    }
    html.push('</tbody></table>');
    $('targets').innerHTML = html.join('');
    for (let k in t) {
        if (t.hasOwnProperty(k)) {
            let v = t[k];
            let d = $(`device-${k}`);
            let time = Date.now().toString(36);
            d.onmouseover = () => {
                $('image').src = `${v.image || ""}?${time}`;
                // if (v.image) {
                //     $('cam').innerHTML = `<img src="${v.image}?${time}" />`;
                // } else {
                //     $('cam').innerHTML = "";
                // }
            };
            d.onmouseout = () => {
                $('image').src = "";
                // $('cam').innerHTML = '';
            };
        }
    }
}

function div(text) {
    return ['<div>',text,'</div>'].join('');
}

function cell(type, text, opt) {
    if (opt) {
        let os = [type];
        for (let k in opt) {
            os.push(`${k}="${opt[k]}"`);
        }
        type = os.join(' ');
    }
    return ['<', type, '>', text, '</', type, '>'].join('');
}

function from_tag(v) {
    let ktag = `tag-${v}`;
    let otag = localStorage[ktag]
    let ntag = prompt(`rename "${v}"`, otag || v);
    if (ntag === '') {
        delete localStorage[ktag];
    } else if (ntag !== null) {
        localStorage[ktag] = ntag;
    }
    console.log({from_tag: v || "ok", ktag, otag, ntag, lastQ});
    queue(lastQ);
}

function print_cancel(target) {
    if (confirm(`cancel print on "${target}?"`)) {
        fetch(`/api/print.cancel?target=${target}`)
            .then(r => r.json())
            .then(c => {
                console.log({cancel: c});
            });
    }
}

function queue_del(time) {
    if (!confirm('delete entry?')) {
        return;
    }
    fetch(`/api/queue.del?time=${time}`)
        .then(r => r.json())
        .then(q => queue(q));
}

function queue(q) {
    lastQ = q.slice();
    let html = [
        '<table><thead><tr>',
        cell('th', div('date')),
        cell('th', div('to')),
        cell('th', div('from')),
        cell('th', div('file')),
        cell('th', div('size')),
        cell('th', div('status')),
        '</tr></thead><tbody>'
    ];
    q.reverse().forEach(el => {
        let target = el.target.comment || el.target.key || el.target;
        let tag = localStorage[`tag-${el.from}`] || el.from;
        let time = el.time || {};
        html.push('<tr>');
        html.push(cell('td', moment(time.add || 0).format('YYYY-MM-DD HH:MM:ss ddd'), { onclick:`queue_del(${time.add})` } ));
        html.push(cell('td', target));
        html.push(cell('td', tag, { onclick:`from_tag('${el.from}')` } ));
        html.push(cell('td', el.name));
        html.push(cell('td', el.size || ''));
        html.push(cell('td', el.status));
        html.push('</tr>');
    });
    html.push('</tbody></table>');
    $('queue').innerHTML = html.join('');
}

function updateTargets() {
    fetch("/api/targets")
        .then(r => r.json())
        .then(t => targets(t));
}

function updateQueue() {
    fetch("/api/queue")
        .then(r => r.json())
        .then(q => queue(q));
}

function init() {
    setInterval(updateTargets, 1000);
    setInterval(updateQueue, 5000);

    updateTargets();
    updateQueue();
}
