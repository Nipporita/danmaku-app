function getQueryString(name) {
    const url_string = window.location.href;
    const url = new URL(url_string);
    return url.searchParams.get(name);
}

function setQueryString(name, value) {
    const url_string = window.location.href;
    const url = new URL(url_string);
    return url.searchParams.set(name, value)
}

function AppendQueryString(name, value) {
    const url_string = window.location.href;
    const url = new URL(url_string);
    return url.searchParams.append(name, value)
}

function getCleanedUrl() {
    const urlString = window.location.href;

    // 解析URL
    const url = new URL(urlString);
    // 去除所有查询参数
    url.search = '';

    // 获取处理后的URL字符串
    return url.toString();
}

function getUrlWithSearch(sp, urlString = null) {
    if (!urlString) {
        urlString = getCleanedUrl();
    }
    url = new URL(urlString)
    for (const key in sp) {
        url.searchParams.set(key, sp[key]);
    }
    return url.toString()
}



// 获取新闻

var news_content = document.getElementById("news_content")

news_content.innerHTML = "暂时不能给你明确答复，这个还需要你自己考量。"

// 获取日推音乐

$.ajax({
    url: "https://fantasyguide.cn/backend/main/get_daily_music", // 请求的URL
    method: 'GET', // 请求方法
    dataType: 'json', //预期数据类型
    success: function(data) {
        var status_code = data.status
        switch (status_code) {
            case 0:
                break;
            default:
                return
        }
        console.log(data)
        
        var wyy_iframe_container = document.getElementById("wyy_iframe_container")

        // 创建新的 iframe 元素
        var iframeElement = document.createElement("iframe");
    
        // 设置 iframe 属性
        iframeElement.frameBorder = "no";
        iframeElement.border = "0";
        iframeElement.width = "330";
        iframeElement.height = "86";
        iframeElement.src = "https://music.163.com/outchain/player?type=2&id=" + data.music_wyy_id + "&auto=0&height=66";
    
        // 将 iframe 元素添加到目标元素内部
        wyy_iframe_container.appendChild(iframeElement);
        
        var music_message_container = document.createElement('div')
        music_message_container.classList.add("music_message_container")

        music_message_container.innerHTML = "<div><span>歌曲名：</span>"+data.music_name+"</div><div><span>作者：</span>"+data.music_author+"</div><div><span>推荐人：</span>"+data.music_recommender+"</div><div><span>推荐理由：</span>"+data.music_recommend_reason+"</div>"

        wyy_iframe_container.appendChild(music_message_container);
    },
    error: function(xhr, status, error) {
        // 处理请求错误
        console.error("请求错误:", error);
    }
})
