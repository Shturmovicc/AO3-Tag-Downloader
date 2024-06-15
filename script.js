(function () {
    const host = "https://archiveofourown.org"

    var savedir = null
    var selectedtag = null
    var fileformat = "pdf"
    var startingpage = 1

    var logElement = null

    var savelock = false
    var searchlock = false


    function escapeFilename(filename) {
        return filename.replaceAll(/[\\/:*?|<>" ]/g, '_')
    }

    function encodeTag(tag) {
        return encodeURI(tag).replace('/', '*s*')
    }

    function newTimeout(time) {
        return new Promise((res) => { setTimeout(res, time) })
    }

    function randomDigit() {
        return Math.floor(Math.random() * 10000)
    }

    async function mkdir(dirhandler, dirname) {
        return dirhandler.getDirectoryHandle(dirname, { create: true })
    }

    async function mkfile(dirhandler, filename) {
        return dirhandler.getFileHandle(filename, { create: true })
    }

    async function saveFile(filehandler, stream) {
        const writable = await filehandler.createWritable()
        while (true) {
            const { done, value } = await stream.read()
            if (!done) {
                await writable.write(value)
            } else {
                await writable.close()
                break
            }
        }
    }

    async function requestPage(tag, pageIndex, cache = 'default') {
        const url = new URL(`/tags/${encodeTag(tag)}/works?page=${pageIndex}?v=${randomDigit()}`, host)
        let ids_names = []
        while (true) {
            const resp = await fetch(url, { cache: cache })
            if (resp.status == 429) {
                logMessage(logElement, "Reached ratelimit, timeout for 20s")
                await newTimeout(20_000)
            } else {
                const response = await resp.text()
                const ids_regexp = /(?<=href\="\/works\/)(\d+)/g
                const ids = new Set(response.match(ids_regexp))
                for (const id of ids) {
                    const name = response.match(new RegExp(`(?<=/works/${id}\"\>)(.+)(?=\<)`))[0]
                    ids_names.push({ id: id, name: name })
                }
                break
            }
        }
        return ids_names
    }

    async function requestFile(dir, filename, id, fileformat, cache = 'default') {
        while (true) {
            try {
                const url = new URL(`/downloads/${id}/fic.${fileformat}?v=${randomDigit()}`, 'https://download.archiveofourown.org')

                const resp = await new Promise(async (res, rej) => {
                    let timeout = true
                    setTimeout(() => { if (timeout) { rej() } }, 5000)
                    res(await fetch(url, { cache: cache }))
                    timeout = false
                }).catch(() => { throw new Error('timeout') })

                if (resp.status === 200) {
                    const reader = resp.body.getReader()
                    const file = await mkfile(dir, filename)
                    logMessage(logElement, `Saving ${filename}`)
                    await saveFile(file, reader)
                    break
                } else if (resp.status == 429) {
                    throw new Error("ratelimit")
                }
            } catch (e) {
                logMessage(logElement, `${id} Reached ratelimit, timeout for 30s`)
                await newTimeout(30_000)
            }
        }
    }

    function newElement(type, classes = [], styles = {}, options = {}) {
        const className = classes.join(" ")
        const element = Object.assign(document.createElement(type), { className, ...options })
        for (const style in styles) {
            element.style[style] = styles[style]
        }
        return element
    }

    function appendChilds(element, childs = []) {
        for (const child of childs) {
            element.appendChild(child)
        }
        return element
    }

    function getTime() {
        return `[${new Date().toLocaleString(undefined, { timeStyle: 'short' })}]`
    }

    function newLogEntry(time, message) {
        const el = newElement('article', ['logentry'])
        const timeEl = newElement('span', ['time'], {}, { 'textContent': time })
        const messageEl = newElement('span', ['message'], {}, { 'textContent': message })

        return appendChilds(el, [timeEl, messageEl])
    }

    function newLogEvent(message) {
        return new CustomEvent('message', { detail: { message: message, time: getTime() } })
    }

    function logMessage(el, message) {
        el.dispatchEvent(newLogEvent(message))
    }

    window.addEventListener('load', () => {
        const dirbutton = document.getElementById('savedirbutton')
        const fileformatchoice = document.getElementById('fileformats')
        const searchbutton = document.getElementById('searchbutton')
        const searchinput = document.getElementById('searchinput')
        const currenttag = document.getElementById('tag')
        const log = document.getElementById('log')
        logElement = log
        const pageinput = document.getElementById('pageinput')

        const download = document.getElementById('download')

        function disableButtons() {
            dirbutton.classList.remove('enabled')
            fileformatchoice.disabled = true
            searchbutton.classList.remove('enabled')
            searchinput.disabled = true
            pageinput.disabled = true
            download.classList.remove('enabled')
        }

        function enableButtons() {
            dirbutton.classList.add('enabled')
            fileformatchoice.disabled = false
            searchbutton.classList.add('enabled')
            searchinput.disabled = false
            pageinput.disabled = false
            download.classList.add('enabled')
        }

        log.addEventListener('message', (e) => {
            const entry = newLogEntry(e.detail.time, e.detail.message)
            log.appendChild(entry)
        })

        dirbutton.addEventListener('click', async () => {
            if (savelock) return
            savedir = await window.showDirectoryPicker()
            const dirtext = document.getElementById('savedir')
            dirtext.textContent = savedir.name
            logMessage(log, `Set new save directory: ${savedir.name}`)
        })

        fileformatchoice.addEventListener('change', (e) => {
            if (savelock) return
            fileformat = e.target.value
            logMessage(log, `Set new fileformat: ${fileformat}`)
        })

        searchbutton.addEventListener('click', async (e) => {
            if (searchlock || savelock) return
            searchlock = true
            logMessage(log, `Searching for ${searchinput.value}`)
            const page = await requestPage(searchinput.value, 1)
            if (page.length > 0) {
                logMessage(log, `Found tag ${searchinput.value}.`)
                selectedtag = searchinput.value
                currenttag.textContent = selectedtag
            } else {
                logMessage(log, `Error: Tag ${searchinput.value} not found.`)
            }

            searchlock = false
        })

        pageinput.addEventListener('focusout', (e) => {
            const number = Number(pageinput.value)
            if (!number || savelock || startingpage === number) return
            startingpage = number
            logMessage(log, `Set starting page: ${startingpage}`)
        })

        download.addEventListener('click', async () => {
            if (savelock || searchlock) return

            if (!savedir) { logMessage(log, `Error: Save directory not set.`); return }
            if (!selectedtag) { logMessage(log, `Error: Tag not selected.`); return }
            try {
                savelock = true
                disableButtons()
                const newdir = await mkdir(savedir, `${escapeFilename(selectedtag)}_${fileformat}`)

                let pageIndex = Number(startingpage)
                let downloadedCount = 0
                let pagesCount = 0
                while (true) {
                    const resp = await requestPage(selectedtag, pageIndex, 'no-cache')
                    if (resp.length === 0) {
                        logMessage(log, `Reached last page: ${pageIndex}.`)
                        break
                    }
                    logMessage(log, `Downloading page ${pageIndex}.`)

                    const tasks = []
                    for (const work of resp) {
                        const filename = `${escapeFilename(work.name)}_${work.id}.${fileformat}`
                        tasks.push(requestFile(newdir, filename, work.id, fileformat, 'no-cache'))
                    }
                    const resolved = await Promise.all(tasks)
                    downloadedCount += resolved.length
                    pagesCount += 1
                    pageIndex += 1
                }
                logMessage(log, `Total downloaded pages: ${pagesCount}, Total downloaded fics: ${downloadedCount}`)
                savelock = false
                enableButtons()
            } catch (err) {
                savelock = false
                enableButtons()
                throw err
            }
        })

    })


})()